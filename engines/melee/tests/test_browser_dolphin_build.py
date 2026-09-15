"""Checks the distribution boundary without compiling or supplying a game."""
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.util.spec_from_file_location('browser_dolphin_build', ROOT / 'tools/build_browser_dolphin.py')
builder = importlib.util.module_from_spec(loader)
loader.loader.exec_module(builder)


class BrowserDolphinPackageTests(unittest.TestCase):
    def test_runtime_allowlist_omits_disc_caches_and_untracked_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            subprocess.run(['git', 'init', '--quiet', source], check=True)
            included = ['LICENSE', 'src/core-host.js', 'src/deep/worker.js', 'src/styles.css']
            excluded = ['private.iso', 'src/game.iso', 'src/jit-cache.bin', 'docs/screenshot.png', 'tools/build.mjs']
            for name in included + excluded:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            subprocess.run(['git', 'add', '.'], cwd=source, check=True)
            (source / 'src/untracked.js').write_text('must not publish')
            self.assertEqual(builder.runtime_files(source), sorted(included))

    def test_vendor_archive_excludes_ignored_game_and_jit_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            vendor = source / 'vendor/dolphin'
            vendor.mkdir(parents=True)
            subprocess.run(['git', 'init', '--quiet', vendor], check=True)
            (vendor / '.gitignore').write_text('*.iso\n*.bin\n')
            (vendor / 'main.cpp').write_text('source')
            subprocess.run(['git', 'add', '.'], cwd=vendor, check=True)
            (vendor / 'game.iso').write_bytes(b'private fixture')
            (vendor / 'prebuilt-jit-cache.bin').write_bytes(b'private fixture')
            (vendor / 'untracked.cpp').write_text('not a build input')
            (vendor / 'locked-patch.cpp').write_text('declared added source')
            provenance = source / 'provenance'
            provenance.mkdir()
            (provenance / 'dolphin-vendor-snapshot-v1.json').write_text(json.dumps({
                'root': {'records': [{'path': 'locked-patch.cpp', 'status': 'A'}]}, 'submodules': []}))
            (provenance / 'dolphin-source.lock.json').write_text('{}')
            self.assertEqual(builder.vendor_source_files(source), ['.gitignore', 'locked-patch.cpp', 'main.cpp'])

    def test_source_archive_omits_tracked_binaries_and_disabled_dependencies(self):
        included = ['Source/Core/main.cpp', 'CMakeLists.txt', 'Externals/fmt/LICENSE']
        excluded = ['Externals/Qt/LICENSE', 'Externals/FFmpeg-bin/file.lib',
                    'Externals/mGBA/cinema/test.gb', 'Source/fixture.DOL',
                    'Source/cache.bin', 'Externals/tool.exe', 'Externals/SDL/source.c']
        with patch.object(builder, 'vendor_source_files', return_value=included + excluded):
            self.assertEqual(builder.archive_vendor_files(Path('/unused')), included)

    def test_source_archive_only_preserves_internal_included_symlinks(self):
        included = {'library/README', 'library/README.md', 'LICENSE'}
        self.assertEqual(builder.archive_symlink_target('library/README.md', 'README', included), 'README')
        self.assertEqual(builder.archive_symlink_target('library/LICENSE', '../LICENSE', included), '../LICENSE')
        self.assertIsNone(builder.archive_symlink_target('library/tool', 'tool.bin', included))
        for target in ('/etc/passwd', '../../private.iso'):
            with self.assertRaisesRegex(ValueError, 'escapes'):
                builder.archive_symlink_target('library/link', target, included)

    def test_cargo_sources_must_match_lock_checksum(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / 'tools/naga-spirv-wgsl'
            manifest.mkdir(parents=True)
            cache = root / 'registry/cache/registry-id'
            cache.mkdir(parents=True)
            payload = b'upstream source archive fixture'
            (cache / 'naga-26.0.0.crate').write_bytes(payload)
            (manifest / 'Cargo.lock').write_text(
                '[[package]]\nname = "naga"\nversion = "26.0.0"\n'
                'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
                'checksum = "' + hashlib.sha256(payload).hexdigest() + '"\n')
            with patch.dict(os.environ, {'CARGO_HOME': str(root)}):
                self.assertEqual(builder.cargo_source_archives(root), [cache / 'naga-26.0.0.crate'])
                (cache / 'naga-26.0.0.crate').write_bytes(b'mutated')
                with self.assertRaisesRegex(ValueError, 'checksum-verified'):
                    builder.cargo_source_archives(root)

    def test_single_port_prebuilt_cannot_be_mislabeled_as_multiplayer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'dolphin-core-upstream.build.json').write_text(json.dumps({'controllerPorts': 1}))
            with patch.object(builder, 'verify_source'):
                with self.assertRaisesRegex(ValueError, 'four-controller'):
                    builder.package(root, root, root / 'dist')
            self.assertFalse((root / 'dist').exists())

    def test_built_artifact_mutation_is_rejected_before_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'dolphin-core-upstream.wasm').write_bytes(b'changed')
            (root / 'dolphin-core-upstream.build.json').write_text(json.dumps({
                'controllerPorts': 4, 'revision': builder.spec()['revision'],
                'artifacts': {'dolphin-core-upstream.wasm': '0' * 64},
            }))
            with patch.object(builder, 'verify_source'):
                with self.assertRaisesRegex(ValueError, 'artifact changed'):
                    builder.package(root, root, root / 'dist')
            self.assertFalse((root / 'dist').exists())


if __name__ == '__main__':
    unittest.main()
