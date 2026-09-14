# Unified OpenSmash integration

OpenSmash is one product with Smash 64 and Melee experiences. The public repository
is the canonical home. `web-prototype` owns the launcher, accounts, creation,
roster browsing and navigation. Melee-specific source lives in `engines/melee`.
BattleShip remains the SSB64 upstream dependency; existing native and ROM build
commands remain supported. “SM64” in planning refers to Smash 64, not Mario 64.

## Required behavior

- `/` selects Smash 64; `/melee` selects Melee. Both use the existing launcher.
- An experience selector navigates to stable URLs and disposes the old engine.
- Browser and native desktop clients support both experiences. Desktop bundles
  the shared frontend and talks to the same hosted account/creation services.
- Platform adapters own setup, launch, stop, input, audio and display. The shared
  launcher must not depend on Electron or any particular engine protocol.
- Disc readiness and clearing are experience-specific, separate from account
  authentication. Browser game bytes remain local. Native storage is persistent.
- Controller discovery and assignment are shared. Bindings remain engine-specific;
  GameCube input must consume raw devices, never N64-remapped gamepad values.
- Shared character identity does not imply shared binary assets. Melee conversion
  is versioned and cached by character revision, moveset and costume variant.
- Preserve Melee launch-plan validation, including costume and transformation limits.

## Migration and release boundaries

The Melee import records its source revision in `engines/melee/IMPORT.json`.
Only tracked source is imported; discs, generated assets, secrets and local build
caches are excluded. Native packaging stays with the engine during migration.
Do not deploy, archive repositories, or redirect releases as part of this branch.

## Acceptance matrix

Verify Smash 64 and Melee independently in browser and desktop: initial disc setup,
roster selection, launch modes, gamepad and keyboard bindings, reconnect, audio,
fullscreen, return to launcher, experience switching, cached/offline local play,
and errors. Verify the existing character-creation and account flows still work.
Build desktop packages on their target platforms; a frontend build is not proof
that native engines or installers work.

## Known integration dependencies

The imported Melee server is a private local conversion service, not a public API.
Its browser launch still calls conversion endpoints gated on server disc setup.
Public deployment requires replacing that dependency with a hosted conversion
contract and local application of any game-derived assets. Do not expose the
private server or pretend a copied catalog makes arbitrary characters playable.

The current SSB64 launcher uses iframe lifecycle and automatic port assignment;
Melee uses a worker/native session and explicit port plans. Shared adapter code
must preserve both behaviors rather than treating their URLs as interchangeable.

## Branch implementation status

Implemented:
- Imported 1,599 tracked Melee files, with source revision and pinned decomp
  submodule recorded; local inputs and generated outputs were excluded.
- Melee source is under `engines/melee`. SSB64 launch translation is under
  `engines/ssb64/launcher`, with a compatibility re-export at its former path.
- `/melee` uses the shared roster and settings shell. A lazy engine adapter mounts
  the existing Melee runtime components without the standalone Melee launcher.
- Melee consumes shared port assignments and raw gamepad input, and keeps its own
  bindings, movesets, stages and rules. Native binding preferences are persisted.
- Namespaced asset/API URLs coexist with SSB64. Local development can set
  `MELEE_LOCAL_ORIGIN=http://127.0.0.1:8781` to reach the imported local backend.
  This local converter proxy is deliberately unavailable in production.
- API Docker build inputs include only the frontend adapters and server dispatch,
  never engine build caches or discs. Existing SSB64 native/ROM commands remain.

Not yet implemented or validated:
- A production Melee asset/conversion service, including arbitrary private and
  newly created characters. The adapter currently uses the prepared Melee catalog.
- A distributable desktop client with both engines. `desktop/dev.py` now runs an
  opt-in shared shell with a bundled frontend, local Melee dispatch, and native
  SSB64 process dispatch. SSB64 opens its own window and currently supports default
  player-one input only. This prototype does not establish native-client parity.
- Per-device GameCube binding profiles, native/browser device identity mapping,
  automatic in-match hot-plug assignment, and complete touch controls.
- End-to-end real-disc combat checks and fresh native installers on Windows/macOS.
- Repointing hosted desktop release triggers from the old repository. Imported
  `.github` workflow definitions remain reference files under the Melee folder;
  they are not automatically active in this repository.

Local UI verification confirmed that `/melee` renders the shared roster, selecting
an existing fighter opens the Melee disc setup, and Return to roster closes it.
This does not establish engine gameplay or native parity. Do not label this branch
release-ready based on the frontend build or unit tests.

Native prototype verification confirmed the bundled launcher can navigate between
experiences and display Melee settings. An isolated copy of the existing SSB64
native build started through the adapter, remained running, and stopped through
its lifecycle API. No game-derived assets were added to version control. Full
combat, account login, offline operation, and native rendering parity remain
unverified. See `desktop/README.md` for the experimental development command.

## Validation recorded for this branch

- Shared frontend production build passed; the existing large-chunk warning remains.
- Shared website suite: 282 passed.
- Engine/desktop adapter and Melee JavaScript regression checks: 24 passed,
  one local-disc fixture skipped.
- Imported Melee Python suite: 143 passed, 15 asset/environment-dependent skips.
- Existing SSB64 build-driver tests: 13 passed.
- Melee frontend TypeScript check passed.
- Git whitespace checks passed; third-party license files retain their original bytes.

These checks validate the migration and prototype boundaries. They do not replace
real-disc gameplay testing, packaged-client verification, or the acceptance matrix.
