# Smash 64 browser lockstep

The website's WebTransport session exchanges **confirmed inputs for each VI
simulation tick**. `PortPushFrame` returns before cheats, VI retrace, controller
reads or coroutine resumes until the four-port batch for that tick arrives.
Input is held constant for every controller read in that tick. No prediction or
rollback is performed. A slow or disconnected player stalls the match.

The game starts from the room's common launch URL and RNG seed. The patch also
replaces the game's time-derived random helpers with its seeded generator for
network sessions, and disables the wall-clock matchup card. Non-network play
retains the upstream behavior. The boot input is neutral on every peer.

`web-prototype/public/ssb64-netplay.js` connects the engine iframe to its parent's
session. The server injects it with the controller remapper. Before `callMain`,
the bridge checks the **compiled** `_port_netplay_version` export and hashes the
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
python3 engines/ssb64/netplay/build.py --engine /path/to/BattleShip --rom /path/to/baserom.us.z64
```

The command archives committed source into the repository's ignored `build`
directory, applies the patches, builds WASM and Torch, and packages `web-dist`.
It never edits the input checkout. `--prepare-only` stops after staging source.
`--source` chooses a new empty output directory. Serve the resulting `web-dist`
with `OPENSMASH_ENGINE_ROOT=/absolute/path/to/web-dist` when starting the
website; the website provides the bridge script.

## Validation boundary

Tests exercise delayed/missing frames, exact input publication, malformed
payloads, capability rejection, startup ordering and common seed setup. The
engine patches are pinned so upstream changes cannot silently move the gate.
Actual two-browser gameplay, especially cross-browser floating-point behavior,
requires the compiled runtime and a user-provided ROM. The startup fingerprint
covers assets already loaded into MEMFS; assets loaded later from a mutable
roster URL are outside that fingerprint. Use a common direct-match lineup with
content-addressed character assets for online sessions. A state snapshot,
rollback recovery and authoritative anti-cheat are not implemented here.
