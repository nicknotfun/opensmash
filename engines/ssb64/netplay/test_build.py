"""Compile the actual browser gate with a mocked EM_ASM host; no ROM required."""
from pathlib import Path
import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


spec = importlib.util.spec_from_file_location("opensmash_ssb64_build", HERE / "build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    @staticmethod
    def staged_source(_engine, source):
        source.mkdir(parents=True)
        (source / "web-dist").mkdir()
        (source / "opensmash-netplay-build.json").write_text('{"capability":2}\n')

    def test_browser_build_needs_no_rom_and_does_not_discover_local_game_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine, source = root / "engine", root / "source"
            engine.mkdir()
            (engine / "baserom.us.z64").write_bytes(b"private fixture; never copy implicitly")
            with mock.patch.object(builder, "stage", side_effect=self.staged_source), mock.patch.object(builder, "run") as run:
                builder.main(["--engine", str(engine), "--source", str(source), "--jobs", "2"])
            self.assertFalse((source / "baserom.us.z64").exists())
            self.assertEqual(len(run.call_args_list), 4)
            self.assertEqual(run.call_args_list[0].args[0][0:2], ["emcmake", "cmake"])
            self.assertIn("-DCMAKE_EXE_LINKER_FLAGS=-lexports.js", run.call_args_list[0].args[0])
            self.assertIn("BattleShip.js", run.call_args_list[1].args[0])
            self.assertEqual(run.call_args_list[2].args[0], ["bash", "scripts/build_torch_wasm.sh"])
            self.assertEqual(run.call_args_list[3].args[0], ["bash", "scripts/package_web.sh", "build-wasm", "web-dist"])
            self.assertEqual((source / "web-dist/opensmash-netplay-build.json").read_text(), '{"capability":2}\n')

    def test_explicit_rom_is_linked_only_into_the_private_build_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rom, source = root / "owned.z64", root / "source"
            rom.write_bytes(b"explicit local fixture")
            with mock.patch.object(builder, "stage", side_effect=self.staged_source), mock.patch.object(builder, "run"):
                builder.main(["--engine", str(root / "engine"), "--source", str(source), "--rom", str(rom)])
            self.assertTrue((source / "baserom.us.z64").is_symlink())
            self.assertEqual((source / "baserom.us.z64").resolve(), rom)
            self.assertEqual(rom.read_bytes(), b"explicit local fixture")
            self.assertFalse((source / "web-dist/baserom.us.z64").exists())

    def test_bad_explicit_rom_fails_before_staging_or_running_build_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with mock.patch.object(builder, "stage") as stage, mock.patch.object(builder, "run") as run:
                with self.assertRaisesRegex(ValueError, "optional --rom"):
                    builder.main(["--engine", str(root), "--source", str(root / "source"), "--rom", str(root / "missing.z64")])
                stage.assert_not_called()
                run.assert_not_called()

    def test_prepare_only_stages_patches_without_building(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with mock.patch.object(builder, "stage", side_effect=self.staged_source) as stage, mock.patch.object(builder, "run") as run:
                builder.main(["--engine", str(root), "--source", str(root / "source"), "--prepare-only"])
                stage.assert_called_once()
                run.assert_not_called()


class RuntimeTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("c++"), "C++ compiler unavailable")
    def test_seed_and_fail_closed_frame_boundary(self):
        with tempfile.TemporaryDirectory(prefix="ssb64-netplay-runtime-") as directory:
            root = Path(directory)
            (root / "emscripten.h").write_text("""
#pragma once
#define EMSCRIPTEN_KEEPALIVE
extern int test_gate(unsigned tick);
extern int test_wait(unsigned tick);
#define EM_ASM_INT(code, tick) test_gate(tick)
#define EM_ASYNC_JS(type, name, args, ...) type name args { return test_wait(tick); }
""")
            (root / "test.cpp").write_text("""
#include <cassert>
#include <cstdint>
#include <cstdlib>
extern "C" int port_netplay_version();
extern "C" int port_netplay_enabled();
extern "C" void port_netplay_init();
extern "C" int port_netplay_before_frame(uint32_t);
extern "C" int port_netplay_wait_frame(uint32_t);
static uint32_t seed;
static int calls = 0;
static unsigned last_tick = 0;
static bool available = false;
extern "C" void syUtilsSetRandomSeed(int32_t value) { seed = (uint32_t)value; }
int test_gate(unsigned tick) { ++calls; last_tick = tick; return available; }
int test_wait(unsigned tick) { return tick == 17; }
int main() {
  unsetenv("SSB64_LOCKSTEP");
  port_netplay_init();
  assert(port_netplay_version() == 2);
  assert(!port_netplay_wait_frame(0));
  assert(port_netplay_wait_frame(17));
  assert(!port_netplay_enabled());
  assert(port_netplay_before_frame(0));
  assert(calls == 0);
  setenv("SSB64_LOCKSTEP", "1", 1);
  setenv("SSB64_LOCKSTEP_SEED", "4045620583", 1);
  port_netplay_init();
  assert(port_netplay_enabled());
  assert(seed == 0xf1234567u);
  unsigned tick = 0;
  for (int retry = 0; retry < 100; ++retry) {
    if (port_netplay_before_frame(tick)) ++tick;
  }
  assert(tick == 0 && calls == 100 && last_tick == 0);
  available = true;
  if (port_netplay_before_frame(tick)) ++tick;
  assert(tick == 1);
  available = false;
  assert(!port_netplay_before_frame(tick));
  assert(last_tick == 1);
}
""")
            binary = root / "runtime-test"
            subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-D__EMSCRIPTEN__", "-I", str(root), str(HERE / "runtime.cpp"), str(root / "test.cpp"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
