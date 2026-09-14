# Shared native launcher (experimental)

`site.cjs` serves the **bundled** frontend under the website origin inside Electron.
Website APIs and authentication remain online services; `/melee/api` requests go
to the token-protected local Melee backend. Native credentials never reach the
website. Hashed frontend assets must exist in the bundle; missing assets do not
silently fall back to a different live frontend release.

The host currently reuses the Melee Electron surface and lifecycle implementation
under `engines/melee/desktop`. Its normal standalone release remains available.
Shared mode has a separate `OpenSmash Integration` user-data directory, so it does
not replace the settings or disc setup of an existing Melee installation.

## Develop

1. Install frontend dependencies in `web-prototype`, and the existing Melee web,
   desktop and Python dependencies under `engines/melee`.
2. Prepare the existing Melee runtime/character payloads using its native release
   tooling. They belong in `engines/melee/build`, never in source control.
3. Build SSB64 using the root `build.py native` command.
4. Run with the Python environment containing Melee's native service dependencies:

```sh
OPENSMASH_SSB64_RUNTIME=/absolute/path/to/native-ssb64-build python desktop/dev.py
```

`OPENSMASH_DESKTOP_DATA` optionally selects another test-only user-data directory.
The SSB64 adapter opens the native engine window and stops its process when the
launcher closes the session or changes experiences. Melee uses its existing
embedded native surface. Only default player-one native SSB64 input is currently
supported; custom assignments are rejected rather than silently ignored.

## Remaining release requirements

This is not a distributable two-engine client yet. Remaining work includes SSB64
runtime packaging without game-derived assets, portable dependencies, shared
native input profiles/hot-plugging, offline roster and asset persistence, end-to-end OAuth
verification, audio changes during native matches, and full engine/UI parity
checks on both Windows and macOS. The shared mode is opt-in and no hosted release
trigger has been changed.

Run adapter tests with `node --test desktop/*.test.cjs engines/ssb64/desktop/*.test.cjs`.

The shared Settings menu and macOS shortcut now include Melee disc management and
per-controller button profiles. The native host permits only the website's auth
handler to open a sandboxed popup without the engine preload. Trailer playback
was checked on both experience routes. Native device identity mapping, SSB64
custom bindings, and live engine audio remain separate parity work.
