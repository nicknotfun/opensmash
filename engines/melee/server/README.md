# Hosted Melee conversion service

The website remains the public API and authentication authority. Configure its
`MELEE_SERVICE_ORIGIN` to the private service's HTTPS origin and supply the same
random secret (at least 32 characters) as `MELEE_SERVICE_TOKEN` on both services.
Never put that secret in Vite/browser configuration. `MELEE_LOCAL_ORIGIN` remains
a development-only alternative; do not set both origins.

The gateway strips website cookies and client-supplied service headers, then
supplies the verified account identity (or a signed guest identity). The service
allows engine assets, conversion jobs, costumes and character-select assets.
Disc setup, game-file access, debug and native-process routes are unavailable.
Imported fighters, jobs and selection assets require persistent owner grants.
Generated public fighters can be exported for play; private fighters require their
owner's current account. Source exports contain generated art, never source
photos or prompts.

## Run

Build from the public repository root:

```sh
docker build -f engines/melee/server/Dockerfile -t opensmash-melee-service .
```

Provision a **private, durable, writable POSIX volume** at `/data`, using your
existing verified conversion workspace (`assets/game` and
`build/web-game/verified.json`). Mount the matching browser runtime at
`/inputs/browser`, source character library at `/inputs/characters`, and Dolphin
Sys files at `/inputs/sys`, all read-only. These inputs are intentionally absent
from the container build context/image and source control. The API does not
accept discs or expose the provisioned game files.

Run one service process per workspace, with port 8782 behind your TLS/private
network proxy. Supply `MELEE_SERVICE_TOKEN` through a secret store/environment
file. Do not use an ephemeral filesystem or multiple replicas sharing the same
workspace: conversion caches, queued jobs and owner grants are local. A restarted
process retains completed imports/grants; in-flight jobs fail and can be retried.
The queue is bounded to 16 jobs and the existing importer validates source origin,
manifest checksums and file sizes. `MELEE_SOURCE_ORIGINS` is a comma-separated
allowlist and defaults to the two smash.fun origins.

For a local smoke test, run `tools/serve_hosted.py --workspace /private/workspace`
from the engine Python environment, with `MELEE_BROWSER_BUILD`,
`OPENSMASH_CHARACTER_ROOT`, `MELEE_SYS_ROOT`, and `MELEE_SERVICE_TOKEN` set.
The same headers used by the gateway are required even on localhost. Check a
known `/api/prepare/<slug>` and `/engine/sys-manifest.json`; `/api/setup`,
`/api/game/...` and `/api/native/status` must return 404.

No production service or website deployment is performed by these scripts.
