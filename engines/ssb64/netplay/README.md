# Smash 64 browser lockstep

The website's WebTransport session exchanges **confirmed inputs for each VI
simulation tick**. The online main loop awaits that batch and a monotonic 60 Hz
timer deadline before calling `PortPushFrame`. Its synchronous guard prevents
cheats, VI retrace, controller reads or coroutine resumes without confirmed input.
Input is held constant for every controller read in that tick. No prediction or
rollback is performed. A slow or disconnected player stalls the match.

## Simulation and presentation

Online scheduling never waits for `requestAnimationFrame`. Confirmation wakes
the simulation wait directly; the 60 Hz clock limits its speed independently of
the display's refresh rate. After a long stall it allows at most two overdue
ticks, discards excess wall-time debt, and preserves every numbered input and
simulation tick. Every tick yields a browser task so buffered inputs cannot
starve network/UI work. An already committed tick can be retried without
resampling input. Ordinary offline play retains its existing display pacer.

The browser compositor displays the latest completed canvas image. Fast3D still
executes each tick's graphics commands synchronously: those commands reference
live guest memory and calculate emulated RCP task timing. They cannot safely be
deferred across simulation ticks or skipped as if they were independent image
snapshots. The online build disables interpolated subframe pacing and SDL's
implicit Asyncify yields. Rendering/GPU cost still shares the simulation thread;
this is independent scheduling, not a separate headless or parallel renderer.
Browser timer throttling, a slow GPU or a blocked main thread can still stall an
online match. Moving graphics to another worker needs guest-resource snapshots
and a separate emulated RCP accounting path, plus real-game validation.

The game starts from the room's common launch URL and RNG seed. The patch also
replaces the game's time-derived random helpers with its seeded generator for
network sessions, and disables the wall-clock matchup card. Non-network play
retains the upstream behavior. The boot input is neutral on every peer.

`web-prototype/public/ssb64-netplay.js` connects the engine iframe to its parent's
session. The server injects it with the controller remapper. Before `callMain`,
the bridge requires **compiled** `_port_netplay_version() == 2` and hashes the
WASM, loaded MEMFS assets and launch environment. O2R ZIP resources are hashed
by name and compressed payload, excluding timestamps and archive ordering so
independent extractions of the same ROM match. Each session uses a fresh
isolated SRAM file; ordinary local saves do not enter the game. Loaded engine
configuration is included in the fingerprint. An older compiled engine is
rejected; changing only the HTML cannot enable network play.

## Build

Use the BattleShip and decomp revisions in `upstream.json`, initialize all its
submodules, install its documented prerequisites, and activate emsdk. Then:

```sh
python3 engines/ssb64/netplay/build.py --engine /path/to/BattleShip
```

No developer ROM is required. The command archives committed source into the
repository's ignored `build` directory, applies the patches, builds the game
WASM and native/browser Torch tools, and packages `web-dist`. Players provide
their own ROM in the browser; browser Torch extracts and caches their game
assets locally. The public package excludes `BattleShip.o2r`. Its separate
`files/f3d.o2r` contains the open-source Fast3D shaders required by the renderer.
The game links Emscripten's `exports.js` library to preserve the compiled Wasm
export names, so deployment can verify the netplay capability in optimized builds.
It also explicitly exports `Module.HEAPU8` and `Module.HEAP32`, which the browser
shell and controller bridge use; Emscripten refreshes these views after memory grows.

For local asset extraction during a build, explicitly add
`--rom /path/to/baserom.us.z64`. A ROM in the input checkout is never picked up
automatically. The command never edits that checkout. `--prepare-only` stops
after staging source.
`--source` chooses a new empty output directory. Serve the resulting `web-dist`
with `OPENSMASH_ENGINE_ROOT=/absolute/path/to/web-dist` when starting the
website; the website provides the bridge script.

After building, exercise the actual compiled capability, controller memory views,
and memory-growth updates without a ROM:

```sh
OPENSMASH_TEST_ENGINE_ROOT=/absolute/path/to/web-dist \
  node --test engines/ssb64/netplay/test_runtime.mjs
```

## Validation boundary

Tests exercise 180 ordered simulation ticks with 30 Hz, 144 Hz and absent display
callbacks, bounded catch-up after a minute-long stall, task yields, delayed/missing
frames, exact input publication, malformed payloads, capability rejection,
startup ordering and common seed setup. The
engine patches are pinned so upstream changes cannot silently move the gate.
Actual two-browser gameplay, especially cross-browser floating-point behavior,
requires the compiled runtime and a user-provided ROM. The startup fingerprint
covers assets already loaded into MEMFS; assets loaded later from a mutable
roster URL are outside that fingerprint. Use a common direct-match lineup with
content-addressed character assets for online sessions. A state snapshot,
rollback recovery and authoritative anti-cheat are not implemented here.
