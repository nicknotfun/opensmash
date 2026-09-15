"""Stage pinned BattleShip sources with the browser simulation gate, then build.

Requires an initialized BattleShip checkout, emsdk, and native Torch prerequisites.
No ROM is needed to build the browser runtime: players extract their own assets
in the browser. --rom optionally enables local build-time asset extraction.
The source checkout is never edited.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PIN = json.loads((HERE / "upstream.json").read_text())


def run(args, cwd):
    subprocess.run(args, cwd=cwd, check=True)


def revision(repo):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


def archive_tree(repo, destination):
    """Copy committed source and exact initialized submodules, excluding data."""
    top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=repo, text=True).strip()
    if Path(top).resolve() != repo.resolve():
        raise ValueError(f"Initialize the BattleShip submodule at {repo} first.")
    destination.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(["git", "archive", "HEAD"], cwd=repo, stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            archive.extractall(destination, filter="data")
    finally:
        process.stdout.close()
        if process.wait() != 0:
            raise RuntimeError(f"Could not copy source from {repo}.")
    entries = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=repo).decode().split("\0")
    for entry in filter(None, entries):
        metadata, name = entry.split("\t", 1)
        mode, commit, _ = metadata.split()
        if mode == "160000":
            child = repo / name
            if revision(child) != commit:
                raise ValueError(f"Initialize the pinned submodule revision at {child} first.")
            archive_tree(child, destination / name)


def apply_patches(source):
    for directory, name in [(source, "battleship.patch"), (source / "decomp", "decomp.patch")]:
        patch = str(HERE / name)
        run(["patch", "--batch", "--forward", "--dry-run", "-p1", "-i", patch], directory)
        run(["patch", "--batch", "--forward", "-p1", "-i", patch], directory)
    shutil.copy2(HERE / "runtime.cpp", source / "port/opensmash_netplay.cpp")
    (source / "opensmash-netplay-build.json").write_text(json.dumps(PIN, indent=2) + "\n")


def stage(engine, source):
    if revision(engine) != PIN["battleship"] or revision(engine / "decomp") != PIN["decomp"]:
        raise ValueError("BattleShip or decomp differs from engines/ssb64/netplay/upstream.json. Use the pinned revisions.")
    if source.exists() and any(source.iterdir()):
        raise ValueError(f"Source output must be empty: {source}. Choose a new --source directory.")
    archive_tree(engine, source)
    apply_patches(source)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT / "build/ssb64-netplay-source")
    parser.add_argument("--rom", type=Path, help="Optional user-owned US v1.0 ROM for local asset extraction; omitted for public browser builds")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args(argv)
    if args.jobs < 1:
        raise ValueError("--jobs must be positive.")
    rom = args.rom.resolve() if args.rom else None
    if rom is not None and not rom.is_file():
        raise ValueError("The optional --rom must point to your Smash 64 US v1.0 ROM.")
    source = args.source.resolve()
    stage(args.engine.resolve(), source)
    if args.prepare_only:
        print(f"Patched source ready at {source}")
        return
    # Do not discover or copy a ROM from the input checkout automatically.
    # Upstream leaves extraction targets out of the normal build when absent.
    if rom is not None:
        (source / "baserom.us.z64").symlink_to(rom)
    # Emscripten's named-export library preserves Wasm export names even at
    # -O3, allowing deployment to inspect the compiled netplay capability.
    # Keep the ordinary Module exports and optimized simulation unchanged.
    run(["emcmake", "cmake", "-B", "build-wasm", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DSSB64_VERSION=us", "-DCMAKE_EXE_LINKER_FLAGS=-lexports.js"], source)
    run(["cmake", "--build", "build-wasm", "--target", "BattleShip.js", "-j", str(args.jobs)], source)
    run(["bash", "scripts/build_torch_wasm.sh"], source)
    run(["bash", "scripts/package_web.sh", "build-wasm", "web-dist"], source)
    shutil.copy2(source / "opensmash-netplay-build.json", source / "web-dist/opensmash-netplay-build.json")
    print(f"Set OPENSMASH_ENGINE_ROOT={source / 'web-dist'} when starting the website.")


if __name__ == "__main__":
    main()
