# Browser multiplayer runtime

The browser room uses the shared WebTransport session in
`web-prototype/shared/netplay-client.js`. The native ModernGekko ENet lobby is
separate from this browser path.

## Simulation boundary

`runtime/patches/browser/0007-webtransport-frame-gate.patch` calls
`opensmash_netplay_frame()` on Dolphin's **CPU thread at the VI field boundary**,
before the movie frame counter and serial-controller polls advance. The gate
consumes one ordered packet containing all four controller ports. It blocks on
missing input; rendering callbacks and elapsed wall-clock time cannot advance
the simulation. A disconnect stops the runtime. The network client supplies
the three-frame input delay and confirmed packets.

Online matches create a fresh worker and transient save directory before boot,
use a shared seed for random launch choices, an emulated RTC and fresh memory
card serials, and run CPU/GPU work in one ordered stream. Per-device
shader-readiness pauses are disabled for online play. Readiness hashes the Wasm
build, disc identity, system resources, seed, numeric launch configuration, and
the actual staged costume/character-select bytes. Peers must
match this fingerprint before the host can start.

The worker requires runtime capability version 2 and accepts `netplay-frame` messages with
`frame` and four `[buttons, packedSticks, packedTriggers, connected]` packets.
It emits `netplay-ready` with a fingerprint and `netplay-needed` with the next
emulated frame number. `Game.tsx` samples only the local player's controls and
translates the shared session's confirmed input into these packets. Ordinary
unsynchronized `pad` messages are ignored online.

## Browser presentation

`runtime/web/presentation.mjs` keeps only the latest received bitmap. The page
displays it on its own `requestAnimationFrame` callback. Superseded images are
closed immediately; hiding the tab cancels presentation and releases queued
images. Restoring the tab waits for a fresh image.

Transfers are bounded separately: one bitmap may be in transit from the GPU
pthread to its owner, and one from the owner to the page, with at most one
replacement waiting in the owner. The page acknowledges receipt before drawing.
If a receiver falls behind, the producer drops presentation copies and continues
executing guest commands. Neither image-transfer credits nor RAF advance or
release the emulated input gate.

This separates **browser presentation** from simulation. Guest graphics commands
and the emulated CPU still execute in their deterministic order; their execution
cost can still slow simulation. This does not introduce asynchronous guest GPU
execution or interpolate missing game frames.

## Build and checks

The JavaScript bridge requires a rebuilt Wasm engine. Existing binaries without
`opensmash_netplay_version() == 2` fail closed instead of pretending to synchronize.
From this checkout, change into `engines/melee` and follow the
[playable browser build](CHECKOUT.md#playable-browser-build) steps to prepare the
pinned dependencies and the user's verified disc, then build the Wasm engine.

ROM-independent checks from the repository root (Node 22.13+ and a C++20
compiler required):

```sh
g++ -std=c++20 -pthread -Wall -Wextra -Werror engines/melee/tests/netplay_gate.cpp -o /tmp/melee-netplay-gate-test
/tmp/melee-netplay-gate-test
node --test engines/melee/tests/netplay.test.mjs engines/melee/tests/netplay_session.test.mjs
node --test engines/melee/tests/presentation.test.mjs
```

These verify waiting, ordering, bounded buffering, cancellation, controller
encoding, fingerprint changes, fresh-session startup and bounded independent
presentation scheduling. They do **not** prove
Melee gameplay determinism, performance, or a completed multiplayer match.
Release validation still needs the rebuilt engine and two independent browsers
using the same supported disc: full match/results/rematch, several stages and
characters, delayed input, and disconnect checks. Single-threaded CPU/GPU
performance and browser compatibility must be measured on the actual runtime.
