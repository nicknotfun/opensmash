# Generic browser Melee runtime

This engine is built from open-source Dolphin and a PPC-to-WebAssembly JIT.
The build never accepts or searches for an ISO, game executable, extracted game
workspace, save state, or precompiled game instruction cache. The primary
player selects their ISO in the browser; WORKERFS reads that local `File`.

`upstream.json` pins wasm-dolphin, its patched Dolphin tree, our controller
extension, and the Linux compiler versions. Upstream's build driver is locked
to Windows executable hashes. Our Linux driver preserves its compiler options,
verifies its complete vendor snapshot, records compiler versions and SHA-256
hashes, and adds `-lexports.js` to retain inspectable Wasm capability exports.
It does not claim byte identity with upstream's Windows artifact.

## Build

Install Emscripten **5.0.7** into an isolated emsdk directory, CMake **3.31.10**,
Ninja **1.13.2**, and Rust **nightly-2026-05-15** with `rust-src`. Rust rebuilds
its standard library with atomics for the shared-memory Naga shader translator;
the Cargo dependency graph is locked. Python 3.11+ and Node 22+ run the tooling.
Use a build machine with several CPU cores, at least 16 GiB RAM and 20 GiB free
disk; these are provisional capacity guidelines, not measured minimums.

From the OpenSmash checkout:

```sh
python3 engines/melee/tools/build_browser_dolphin.py prepare --source /path/to/cache/source
python3 engines/melee/tools/build_browser_dolphin.py build \
  --source /path/to/cache/source --output /path/to/cache/built \
  --emsdk /path/to/emsdk --cmake /path/to/cmake --ninja /path/to/ninja \
  --cargo /path/to/dated-rust/bin/cargo --rustc /path/to/dated-rust/bin/rustc --jobs 16
python3 engines/melee/tools/build_browser_dolphin.py package \
  --source /path/to/cache/source --built /path/to/cache/built --output /path/to/new/dist
```

If Rust lives in isolated directories, set its normal `RUSTUP_HOME` and
`CARGO_HOME` environment variables. The output is static website content.
`manifest.json` lists each deployed file and SHA-256 hash, identifies the
four-controller capability, and marks gameplay as unvalidated. The package
includes `generic-source.tar.gz` with the corresponding patched source and
our build tooling, plus GPL license text. Rust/Naga dependency source archives
are included with checksums verified against the pinned Cargo lock. Packaging
requires the same `CARGO_HOME` used by the build. Disabled Windows/platform
dependencies and binary test fixtures are excluded from the source archive.
Serve both beside the runtime.

## Browser integration

Import `src/core-host.js` (`EmulatorHost`) and `src/audio.js`
(`AudioController`) from the packaged directory. The upstream full UI is not
required. `EmulatorHost.mountFile(file)` boots a local disc;
`setInputState(state, port)` accepts ports 0–3. State has `connected`, `mask`,
`stickX`, `stickY`, `cStickX`, `cStickY`, `triggerLeft`, `triggerRight`,
`analogA`, and `analogB`. Stick and analog fields are bytes; centered sticks
use 128. Disconnected seats must send `connected: false`.

`mask` uses upstream `src/input.js` constants (A=bit0, B=bit1, X=bit2,
Y=bit3, Start=bit4, L=bit5, R=bit6, Z=bit7, D-pad=bits8–11).
Convert any shared netplay protocol's button layout before passing it here.
The host assigns ports; guests must not choose a port by editing a packet.

The actual Wasm exports `OpenSmashControllerPorts()` returning 4,
`SetControllerState`, and `OpenSmashReadController`. The last diagnostic reads
Dolphin's actual controller conversion, enabling four-port isolation and
unplug tests without an ISO. The SI bus configures all four controller devices
before boot; seats report their connection status independently.

The upstream JavaScript API may fall back to its demo when boot fails. Product
code must require `mode === 'dolphin'`, `game.fullCore`, and
`game.coreBoot.accepted`, then check changing game ticks/frames. A demo or a
successful boot request does not prove gameplay. The runtime needs
cross-origin isolation (COOP/COEP), shared WebAssembly memory, a worker, and a
supported canvas backend. Its fixed shared memory allocation is **1.5 GiB**.

Audio is available through `mixAudio` or the audio worklet transport. Tee the
Web Audio graph into a `MediaStreamAudioDestinationNode`, and capture the
visible canvas for WebRTC. Stop presentation, terminate the worker and close
the audio context when leaving. An isolated iframe supplies an additional
lifetime boundary and keeps upstream debug URL options out of invitation URLs.

## Limits

This is an experimental browser runtime. No game image was available for
performance or gameplay qualification. Published upstream measurements separate
screen presentations from distinct game frames; neither stable 60 FPS nor
mobile support is established. The initial product should use original Melee
fighters. Custom skins and the previous statically recompiled runtime's hooks
are separate integrations.

## Validation performed

The four-port core was compiled on Linux and instantiated in Node and Chromium
without game data. The Wasm checks exercised dynamic JIT arithmetic, JIT access
to shared emulated memory, all four controller button/analog snapshots, port
bounds and disconnect neutralization. Chromium also loaded the actual adapter
worker under COOP/COEP; a disc-free boot probe correctly remained blocked.

Run the ABI smoke against a local build:

```sh
node engines/melee/tools/check_browser_dolphin.mjs /path/to/cache/built
python3 -m unittest discover -s engines/melee/tests -p test_browser_dolphin_build.py
node web-prototype/server/melee-browser-runtime.js check /path/to/new/dist
```

These checks establish a functioning generic module and controller boundary.
They do not establish successful Melee boot, match rendering, audio or frame rate.
