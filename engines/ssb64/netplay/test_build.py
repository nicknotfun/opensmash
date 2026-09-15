"""Compile the actual browser gate with a mocked EM_ASM host; no ROM required."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


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
