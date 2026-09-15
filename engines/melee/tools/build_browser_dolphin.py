"""Build and package a generic browser Melee host from pinned open-source inputs.

No command accepts, searches for, extracts, uploads, or compiles a game image.
The ISO is supplied to WORKERFS by the browser at runtime only.
"""
from __future__ import annotations

import argparse
import hashlib
import gzip
import io
import tarfile
import json
import os
import posixpath
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = ROOT / 'runtime/browser-dolphin/upstream.json'
PATCH = ROOT / 'runtime/browser-dolphin/four-controllers.patch'
CORE = 'cores/dolphin/dolphin-core-upstream'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args, *, cwd=None, env=None, capture=False):
    print('+ ' + ' '.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def spec():
    return json.loads(SPEC_PATH.read_text())


def verify_source(source):
    pinned = spec()
    actual = run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True).strip()
    if actual != pinned['revision']:
        raise ValueError('Wrong browser Dolphin source revision')
    changed = run(['git', 'diff', '--name-only', 'HEAD', '--'], cwd=source, capture=True).splitlines()
    if set(changed) - set(pinned['patchedSources']):
        raise ValueError('Unexpected changes outside the pinned controller patch')
    for name, expected in pinned['patchedSources'].items():
        path = source / name
        if path.is_symlink() or digest(path) != expected:
            raise ValueError('Unexpected source contents: ' + name)
    for name, expected in pinned['buildInputs'].items():
        if (source / name).is_symlink() or digest(source / name) != expected:
            raise ValueError('Changed pinned build input: ' + name)
    # The vendor verifier covers the complete pinned tree plus 66 patches and
    # submodule deltas. Our four-port bridge changes only the outer project.
    script = "import {verifyVendorSnapshotCheckout} from './tools/dolphin-provenance.mjs'; console.log(JSON.stringify(verifyVendorSnapshotCheckout('vendor/dolphin')));"
    run(['node', '--input-type=module', '-e', script], cwd=source)


def prepare(source):
    pinned = spec()
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        run(['git', 'clone', '--filter=blob:none', '--no-checkout', pinned['repository'], source])
        run(['git', 'checkout', '--detach', pinned['revision']], cwd=source)
    head = run(['git', 'rev-parse', 'HEAD'], cwd=source, capture=True).strip()
    if head != pinned['revision']:
        raise ValueError('Refusing to replace a different source checkout')
    applied = subprocess.run(['git', 'apply', '--reverse', '--check', str(PATCH)], cwd=source,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not applied:
        if run(['git', 'status', '--porcelain'], cwd=source, capture=True).strip():
            raise ValueError('Source checkout must be clean before preparing it')
        run(['node', 'tools/verify-dolphin-provenance.mjs'], cwd=source)
    if not (source / 'vendor/dolphin/.git').exists():
        run(['node', 'tools/fetch-dolphin.mjs'], cwd=source)
    run(['node', 'tools/patch-upstream-wasm.mjs'], cwd=source)
    if not applied:
        run(['git', 'apply', '--check', PATCH], cwd=source)
        run(['git', 'apply', PATCH], cwd=source)
    verify_source(source)


def tool_record(path, args, contains, *, env):
    path = Path(path).resolve()
    text = run([path, *args], env=env, capture=True).strip()
    if contains not in text:
        raise ValueError(f'Expected {contains!r} from {path}, got {text!r}')
    return {'path': str(path), 'sha256': digest(path), 'version': text}


def build(source, output, args):
    verify_source(source)
    if sys.platform != 'linux':
        raise ValueError('This build profile currently targets Linux builders')
    if args.jobs < 1:
        raise ValueError('--jobs must be positive')
    sdk = args.emsdk.resolve()
    emcc = sdk / 'upstream/emscripten/emcc'
    emcmake = sdk / 'upstream/emscripten/emcmake'
    cmake = Path(args.cmake).resolve()
    ninja = Path(args.ninja).resolve()
    cargo = Path(args.cargo).resolve()
    rustc = Path(args.rustc).resolve()
    env = os.environ | {
        'EM_CONFIG': str(sdk / '.emscripten'), 'RUSTC': str(rustc),
        'PYTHONDONTWRITEBYTECODE': '1',
        'PATH': os.pathsep.join([str(cargo.parent), str(emcc.parent), str(cmake.parent), os.environ.get('PATH', '')]),
    }
    versions = spec()['linuxToolchain']
    records = {
        'emcc': tool_record(emcc, ['--version'], versions['emscripten'], env=env),
        'clang': tool_record(sdk / 'upstream/bin/clang', ['--version'], 'clang version', env=env),
        'cmake': tool_record(cmake, ['--version'], versions['cmake'], env=env),
        'ninja': tool_record(ninja, ['--version'], versions['ninja'], env=env),
        'rustc': tool_record(rustc, ['--version', '--verbose'], versions['rustCommit'], env=env),
        'cargo': tool_record(cargo, ['--version'], versions['cargo'], env=env),
    }
    naga = source / 'tools/naga-spirv-wgsl'
    # Include optional locked crate sources in the corresponding-source package.
    run([cargo, 'fetch', '--locked'], cwd=naga, env=env)
    run([cargo, 'build', '--locked', '--release', '--target', 'wasm32-unknown-emscripten'], cwd=naga, env=env)
    library = naga / 'target/wasm32-unknown-emscripten/release/libnaga_spirv_wgsl.a'
    if not library.is_file():
        raise ValueError('Naga shader translator was not produced')
    build_dir = source.parent / 'build'
    output.mkdir(parents=True, exist_ok=True)
    flags = '-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0 -DDOLPHIN_WEB_HOT_COUNTERS=0 -DDOLPHIN_WEB_INLINE_FAST_BRANCH=1 -DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=0 -DDOLPHIN_WEB_FALLBACK_MAP_BITS=16 -DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=0'
    options = {
        'CMAKE_MAKE_PROGRAM': ninja, 'CMAKE_BUILD_TYPE': 'Release',
        'CMAKE_TRY_COMPILE_CONFIGURATION': 'Debug', 'CMAKE_EXPORT_COMPILE_COMMANDS': 'ON',
        'ENABLE_GENERIC': 'ON', 'CMAKE_C_FLAGS': flags, 'CMAKE_CXX_FLAGS': flags,
        'CMAKE_EXE_LINKER_FLAGS': '-lexports.js',
        'CMAKE_C_FLAGS_DEBUG': '-O0 -fno-lto', 'CMAKE_CXX_FLAGS_DEBUG': '-O0 -fno-lto',
        'DOLPHIN_WASM_NAGA_WGSL_LIB': library,
        'DOLPHIN_WASM_JIT_CACHE_PRE_JS': source / 'tools/jit-cache-prejs.js',
        'DOLPHIN_WASM_MEMORY_PAGES': 24576, 'DOLPHIN_WASM_PROJECT_ROOT': source,
        'DOLPHIN_WASM_BRIDGE_SOURCE': source / 'core/upstream/dolphin_web_discio.cpp',
        'DOLPHIN_WASM_SHARED_SOURCE_DIR': source / 'core/upstream',
        'DOLPHIN_WASM_CORE_SOURCE': source / 'core/upstream/dolphin_web_core.cpp',
        'DOLPHIN_WASM_OUTPUT_DIR': output,
    }
    disabled = 'USE_SYSTEM_LIBS ENABLE_QT ENABLE_NOGUI ENABLE_CLI_TOOL ENABLE_HEADLESS ENABLE_ALSA ENABLE_PULSEAUDIO ENABLE_CUBEB ENABLE_X11 ENABLE_EGL ENABLE_SDL ENABLE_VULKAN ENABLE_LLVM ENABLE_TESTS USE_UPNP USE_DISCORD_PRESENCE USE_MGBA USE_RETRO_ACHIEVEMENTS ENABLE_AUTOUPDATE ENABLE_ANALYTICS ENCODE_FRAMEDUMPS WITH_OPTIM WITH_SSE2 WITH_SSSE3 WITH_SSE41 WITH_SSE42 WITH_PCLMULQDQ WITH_AVX2 WITH_AVX512 WITH_AVX512VNNI WITH_VPCLMULQDQ'.split()
    options.update({key: 'OFF' for key in disabled})
    command = [emcmake, cmake, '-S', source / 'vendor/dolphin', '-B', build_dir, '-GNinja', *[f'-D{k}={v}' for k, v in options.items()]]
    run(command, cwd=source, env=env)
    run([cmake, '--build', build_dir, '--target', 'dolphin_web_core', '--parallel', args.jobs], cwd=source, env=env)
    record = {
        'protocol': 1, 'runtime': 'wasm-dolphin', 'revision': spec()['revision'],
        'containsGameData': False, 'controllerPorts': 4, 'toolchain': records,
        'sourcePinSha256': digest(SPEC_PATH), 'controllerPatchSha256': digest(PATCH),
        'nagaSha256': digest(library), 'cmakeOptions': {k: str(v) for k, v in options.items()},
        'artifacts': {p.name: digest(p) for p in output.glob('dolphin-core-upstream.*') if p.suffix in ('.js', '.wasm')},
        'deviations': ['Linux tools are pinned and recorded independently of the upstream Windows executable lock.',
                       'Four local controller ports replace the upstream single-controller bridge.'],
        'gameplayValidated': False,
    }
    (output / 'dolphin-core-upstream.build.json').write_text(json.dumps(record, indent=2) + '\n')


def runtime_files(source):
    """Only checked-in JS/CSS plus exact engine/provenance/license files."""
    names = run(['git', 'ls-files', '-z'], cwd=source, capture=True).split('\0')
    return sorted(name for name in names if
                  (name.startswith('src/') and Path(name).suffix in ('.js', '.css')) or
                  name == 'LICENSE')


def vendor_source_files(source):
    """Only Git-tracked dependencies plus verified additions in the patch lock.

    Untracked/ignored files must never enter a public corresponding-source
    archive, even when a local build cache happens to contain a game image.
    """
    vendor = source / 'vendor/dolphin'
    def tracked(directory):
        return set(filter(None, subprocess.check_output(
            ['git', 'ls-files', '--recurse-submodules', '-z'], cwd=directory).decode().split('\0')))
    names = tracked(vendor)
    snapshot = json.loads((source / 'provenance/dolphin-vendor-snapshot-v1.json').read_text())
    repositories = [('', snapshot['root']['records'])] + [(entry['cwd'] + '/', entry['records']) for entry in snapshot['submodules']]
    for prefix, records in repositories:
        for entry in records:
            name = prefix + entry['path']
            if entry['status'] == 'D': names.discard(name)
            else: names.add(name)
    lock = json.loads((source / 'provenance/dolphin-source.lock.json').read_text())
    for prefix in lock.get('externalRepositories', {}):
        names.update(prefix + '/' + name for name in tracked(vendor / prefix))
    return sorted(names)


# Disabled platform dependencies and binary fixtures are not corresponding
# source for this Linux/WebAssembly profile. Keep all remaining pinned source,
# licenses, build scripts and resources; never include a compiled game or cache.
ARCHIVE_EXCLUDED_PREFIXES = ('Externals/Qt/', 'Externals/FFmpeg-bin/',
    'Externals/mGBA/', 'Externals/SDL/')
ARCHIVE_EXCLUDED_SUFFIXES = frozenset(('.iso', '.gcm', '.rvz', '.wbfs', '.wia',
    '.gcz', '.dol', '.elf', '.wad', '.nsp', '.xci', '.gb', '.gbc', '.gba', '.nds',
    '.nes', '.sfc', '.smc', '.sms', '.rom', '.bin', '.exe', '.dll', '.lib', '.a',
    '.so', '.dylib', '.pdb', '.wasm', '.pyc', '.class', '.jar', '.o', '.obj',
    '.spv', '.zip', '.7z'))


def archive_vendor_files(source):
    return [name for name in vendor_source_files(source)
            if not name.startswith(ARCHIVE_EXCLUDED_PREFIXES)
            and Path(name).suffix.lower() not in ARCHIVE_EXCLUDED_SUFFIXES]


def archive_symlink_target(name, target, included):
    """Preserve a tracked link only to another file inside this source archive."""
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    if target.startswith('/') or resolved == '..' or resolved.startswith('../'):
        raise ValueError('Source symlink escapes the archive: ' + name)
    if resolved not in included:
        # A link to an excluded binary fixture is unnecessary too.
        return None
    return target


def cargo_source_archives(source):
    """Use only registry archives whose full hash matches the pinned Cargo lock."""
    cargo_home = Path(os.environ.get('CARGO_HOME', Path.home() / '.cargo'))
    lock = tomllib.loads((source / 'tools/naga-spirv-wgsl/Cargo.lock').read_text())
    result = []
    for package in lock['package']:
        if 'source' not in package:
            continue
        if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError('Unexpected Rust dependency source')
        name = package['name'] + '-' + package['version'] + '.crate'
        matches = sorted((cargo_home / 'registry/cache').glob('*/' + name))
        match = next((path for path in matches if not path.is_symlink() and
                      digest(path) == package['checksum']), None)
        if match is None:
            raise ValueError('Missing checksum-verified Rust source; set CARGO_HOME used by build: ' + name)
        result.append(match)
    return sorted(result, key=lambda path: path.name)


def source_archive(source, destination, crates):
    """Ship the source used by this artifact; exclude build caches and binaries."""
    def add(archive, name, data, mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data); info.mode = mode; info.mtime = 0
        archive.addfile(info, io.BytesIO(data))
    # Fixed gzip/tar metadata makes repeated packaging reproducible.
    with destination.open('wb') as target, gzip.GzipFile(fileobj=target, mode='wb', filename='', mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w|') as archive:
        names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')
        for name in sorted(filter(None, names)):
            if not (name in ('LICENSE', 'package.json') or name.startswith(('src/', 'core/upstream/', 'patches/', 'provenance/', 'tools/'))):
                continue
            path = source / name
            if not path.is_file() or path.is_symlink(): continue
            content = path.read_bytes() if name in spec()['patchedSources'] else subprocess.check_output(['git', 'show', f'HEAD:{name}'], cwd=source)
            add(archive, 'wasm-dolphin/' + name, content, 0o755 if os.access(path, os.X_OK) else 0o644)
        vendor = source / 'vendor/dolphin'
        included = set(archive_vendor_files(source))
        for name in sorted(included):
            path = vendor / name
            if path.is_symlink():
                target = archive_symlink_target(name, os.readlink(path), included)
                if target is not None:
                    info = tarfile.TarInfo('wasm-dolphin/vendor/dolphin/' + name)
                    info.type = tarfile.SYMTYPE; info.linkname = target
                    info.mode = 0o777; info.mtime = 0
                    archive.addfile(info)
            elif path.is_file():
                add(archive, 'wasm-dolphin/vendor/dolphin/' + name, path.read_bytes(), 0o755 if os.access(path, os.X_OK) else 0o644)
        for path in crates:
            add(archive, 'wasm-dolphin/rust-crates/' + path.name, path.read_bytes())
        for path in [Path(__file__), SPEC_PATH, PATCH, ROOT / 'tools/check_browser_dolphin.mjs', ROOT / 'runtime/browser-dolphin/README.md']:
            add(archive, 'opensmash/engines/melee/' + path.relative_to(ROOT).as_posix(), path.read_bytes())


def package(source, built, output):
    verify_source(source)
    record = json.loads((built / 'dolphin-core-upstream.build.json').read_text())
    if record.get('controllerPorts') != 4 or record.get('revision') != spec()['revision']:
        raise ValueError('A rebuilt four-controller runtime is required; upstream prebuilt is single-port')
    for name, expected in record['artifacts'].items():
        if name not in ('dolphin-core-upstream.js', 'dolphin-core-upstream.wasm') or digest(built / name) != expected:
            raise ValueError('Runtime build artifact changed')
    crates = cargo_source_archives(source)
    if output.exists():
        raise ValueError('Choose a new empty output directory')
    output.mkdir(parents=True)
    for name in runtime_files(source):
        path = source / name
        if path.is_symlink():
            raise ValueError('Runtime payload must not contain symlinks')
        dest = output / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if name in spec()['patchedSources']:
            shutil.copyfile(path, dest)
        else:
            # Do not publish unrelated working-tree edits from a build cache.
            dest.write_bytes(subprocess.check_output(['git', 'show', f'HEAD:{name}'], cwd=source))
    for suffix in ('.js', '.wasm', '.build.json'):
        dest = output / (CORE + suffix)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(built / ('dolphin-core-upstream' + suffix), dest)
    # The worker verifies the compiled module before executing it. Pin this
    # rebuilt output, never the upstream one-controller baseline hash.
    protocol = output / 'src/upstream-worker-protocol.js'
    content = protocol.read_text()
    original = spec()['baselineWasmSha256']
    if content.count(original) != 1:
        raise ValueError('Unexpected upstream worker artifact pin')
    protocol.write_text(content.replace(original, record['artifacts']['dolphin-core-upstream.wasm']))
    abi = {'schemaVersion': 1, 'coreId': 'sha256:' + record['artifacts']['dolphin-core-upstream.wasm'],
           'controllerPorts': 4, 'sharedMemoryBytes': 1610612736,
           'requiredExports': ['OpenSmashControllerPorts', 'SetControllerState', 'OpenSmashReadController'],
           'artifacts': [{'path': CORE + suffix, 'sha256': digest(output / (CORE + suffix)),
                          'size': (output / (CORE + suffix)).stat().st_size} for suffix in ('.js', '.wasm')]}
    (output / 'provenance').mkdir(exist_ok=True)
    (output / 'provenance/dolphin-core-abi-v1.json').write_text(json.dumps(abi, indent=2) + '\n')
    source_archive(source, output / 'generic-source.tar.gz', crates)
    (output / 'SOURCE.md').write_text('# Corresponding source\n\n'
        'The matching open-source source tree, local patch and build driver are in [generic-source.tar.gz](generic-source.tar.gz).\n\nRuntime source: ' + spec()['repository'] + '/tree/' + spec()['revision'] + '\n\n'
        'OpenSmash four-controller patch and Linux build instructions: '
        'https://github.com/nicknotfun/opensmash/tree/main/engines/melee/runtime/browser-dolphin\n\n'
        'Rust/Naga registry sources are included as original rust-crates/*.crate archives, verified against Cargo.lock checksums. These are compressed source archives that can be unpacked with tar.\n\n'
        'The source archive omits disabled Qt, FFmpeg, mGBA and SDL dependencies, and binary/test-ROM artifacts; the exact exclusions are in the included build driver.\n\n'
        'No disc, game executable, save state, or generated game code is included.\n')
    files = {p.relative_to(output).as_posix(): digest(p) for p in sorted(output.rglob('*')) if p.is_file()}
    manifest = {'protocol': 1, 'engine': 'melee', 'runtime': 'wasm-dolphin',
                'revision': spec()['revision'], 'controllerPorts': 4,
                'containsGameData': False, 'gameplayValidated': False,
                'sharedMemoryBytes': 1610612736, 'files': files}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'files': len(files), 'bytes': sum(p.stat().st_size for p in output.rglob('*') if p.is_file())}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'build', 'package'))
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--built', type=Path)
    parser.add_argument('--emsdk', type=Path)
    for tool in ('cmake', 'ninja', 'cargo', 'rustc'):
        parser.add_argument('--' + tool, default=shutil.which(tool))
    parser.add_argument('--jobs', type=int, default=16)
    args = parser.parse_args()
    source = args.source.resolve()
    if args.action == 'prepare': prepare(source)
    elif args.action == 'build':
        if not args.output or not args.emsdk or not all(getattr(args, t) for t in ('cmake', 'ninja', 'cargo', 'rustc')):
            parser.error('build requires --output, --emsdk, --cmake, --ninja, --cargo and --rustc')
        build(source, args.output.resolve(), args)
    else:
        if not args.output or not args.built: parser.error('package requires --output and --built')
        package(source, args.built.resolve(), args.output.resolve())


if __name__ == '__main__':
    main()
