# smash.not.fun deployment

Infrastructure provisioned on 2026-09-15 in GCP project `nicknotfun-opensmash`
(project number `887140158350`), region `us-central1`. Cloudflare account: Cloudy;
zone: `not.fun`.

**Browser-hosted Melee preview is now live.** The primary player runs the generic
emulator in their browser using a local ISO. Guests receive video/audio and send
controller inputs; they need no ISO or emulator. The website and gameplay relay
have no server-side ISO or verified-workspace dependency. Actual Melee gameplay
remains **unvalidated** without a player's local ISO. TURN credentials are pending;
the deployed ICE provider currently supplies STUN for direct connections.

## Resources

| Resource | Configuration |
| --- | --- |
| Website | Cloud Run `opensmash-site`, 1 vCPU / 1 GiB, 0–3 instances; Cloudflare Worker `opensmash-site` |
| Relay | `opensmash-relay`, `us-central1-a`, e2-small, 30 GiB balanced boot disk, `136.64.109.100` |
| Retained legacy Melee VM | `opensmash-melee`, `us-central1-a`, e2-standard-2, 30 GiB balanced boot disk, `34.56.102.20`; unused by browser hosting |
| Retained legacy Melee data | `opensmash-melee-data`, 100 GiB balanced persistent disk, independent of the VM |
| Network | Dedicated `opensmash` VPC and regional subnet; SSH through Google IAP |
| Public assets | `gs://nicknotfun-opensmash-public-assets` |
| Private assets | `gs://nicknotfun-opensmash-private-assets` |
| Database | Firestore Native `(default)`, expiry policy on `handoffRooms.expireAt` for the separate ROM-transfer feature |
| Authentication | Firebase email-link provider, own-domain auth helper, Cloudflare Turnstile |
| Images | Artifact Registry `opensmash` and `opensmash-site` |
| Melee media | Direct browser WebRTC; optional TURN not yet configured |

`relay.smash.not.fun` and the retained `melee-service.smash.not.fun` use DNS-only
A records. The relay accepts direct WebTransport over UDP 443 and REST over
HTTPS 443. Both VMs obtain and renew publicly trusted Let's Encrypt certificates.
The relay has persistent QUIC socket-buffer settings in its startup template.

Private deployment inputs live on devy under
`/home/nick/.config/opensmash-deploy/` with restricted permissions. Secret values
are absent from this repository. Runtime service accounts have separate roles.
The new website configuration omits both `meleeServiceOrigin` and
`meleeServiceToken`; its Cloud Run revision no longer receives
`MELEE_SERVICE_ORIGIN` or `MELEE_SERVICE_TOKEN`. The legacy VM still exists and
returns 503 without its old workspace. No ISO has been supplied to that VM, and
it is not needed for the new browser route.

## Current revisions and images

Implementation commit: **`0ba97bd`**.

| Component | Build/revision |
| --- | --- |
| Website Cloud Build | `2d534695-2b63-428c-81d7-297d59a4ca2a` |
| Website Cloud Run | `opensmash-site-00005-tml`, 100% traffic |
| Relay Cloud Build | `311152f8-5d29-4c50-ab6b-f8d18c73d0d3` |
| Cloudflare Worker | `b29a1b46-ef2c-44db-9acc-8e6824c86085` |

Website origin: `https://opensmash-site-oxrdjed7ra-uc.a.run.app`.
The image includes both the existing Smash64 runtime and the generic Melee
browser runtime:

```text
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash-site/website@sha256:d4b0bd85e5a0360c4e771145615319711de4ff0cdfa4c3df04620d9fbac22a2f
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash/relay@sha256:f103cce98b4489bc42993e16268ed430af3cb9b43a11ffb1dc8b4959c28a5e4e
```

The retained, unused legacy conversion VM still has its previous image:

```text
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash/melee@sha256:f6bd2a95d27e0f4cd3b72a7c7d11c2d8d69742635ded03f463a5a7fbbaa3feae
```

### Generic Melee runtime

Local release package:
`/home/nick/.cache/opensmash-deploy/browser-dolphin/dist-release`.

| Property | Verified value |
| --- | --- |
| Package | 72 files, 77,389,615 bytes |
| Source revision | `7e38409ace3dda709c178312ff63fd92a3653cc7` |
| Controller ports | Four, verified against actual Wasm controller exports |
| Browser shared memory | 1,610,612,736 bytes (1.5 GiB), allocated on the host device |
| Contains game data | `false` |
| Gameplay validated | `false` |
| Wasm SHA-256 | `3cd7029d6a06da1f1deb926673fd51cc10a9e333f4ef21a755082c6b22499f27` |
| Source archive SHA-256 | `de58a9c526282e73a68dca0c46e70a0a4ca46c49501ece9b247750fa208e6ca9` |

The package contains pinned generic emulator code, our controller bridge, build
records, license, and corresponding source archive. Preflight verified every
manifest-listed hash, rejected symlinks/unlisted files, and checked that the
actual controller capability returns four. Cloud Build checked it again inside
the website image. The module, JIT, shared emulated memory, four-controller input
and disconnect behavior, and an actual Chromium worker passed disc-free checks.
These checks do not establish successful Melee boot, match rendering/audio, or
frame rate.

## Live verification

### Browser-hosted Melee rollout

Verified through `https://smash.not.fun` after the new revision received traffic:

- `/melee` presents browser hosting and creates a unique host-stream game link.
- The host reaches the local ISO picker. Guests receive the streaming UI with
  no ISO picker and no emulator iframe. These flows make no legacy Melee
  conversion/runtime requests.
- The actual generic emulator/Wasm worker loaded through the public website
  with shared-memory isolation intact. The disc-free probe made no application
  or game-upload POSTs; its only POST was the same-origin `/cdn-cgi/rum`
  Cloudflare Insights telemetry beacon. This remains a runtime-load check, not
  a successful ISO boot or gameplay test.
- Four browsers exchanged real WebRTC video/audio and all three guests'
  controller states using the deployed WebTransport signaling and authenticated
  ICE endpoint. Guest replacement/rejoin and new host offers passed.
- Input neutralization after silence/disconnection was observed in 345 ms in
  the smoke run. The test ended its own room.
- The deployed ICE response reported `relay:false`: this tested direct WebRTC
  with STUN, not a TURN-mediated route.

The actual public worker report is
`/home/nick/.config/opensmash-deploy/live-melee-browser-worker.json`: loaded and
isolated, no game mounted, no page errors or legacy-service requests.
The private streaming report is
`/home/nick/.config/opensmash-deploy/live-melee-host-stream.json`. The
[streaming smoke harness](../netplay/tests/host-stream-smoke.mjs) generates its
own canvas/audio; it proves the media/input/signaling paths without requiring
or uploading a ROM. It does not prove real Melee gameplay.

### Smash64 compatibility after the relay update

The [live lockstep harness](../netplay/tests/live-smoke.mjs) passed against the
updated public relay in an explicitly selected Smash64 room. Four Chromium
151.0.7922.75 clients used ordinary public certificate validation and received
identical 180-frame input sequences. A fifth player was rejected. Presentation
ran at 30/60/144 Hz or had no display callbacks; all four simulations completed
180 ticks and released all 180 offered bitmaps. Disconnecting a player stopped
all peers and ended the test room.

Private evidence:
`/home/nick/.config/opensmash-deploy/live-ssb64-lockstep-af2m_5yi/`.
The run used a private harness copy selecting `engine:"ssb64"`; no game files
or repository changes were needed. Its input-frame hash matches the previous
live lockstep check:

```text
4a4f1ccd16546746ccc112ca2a7f7f38cf4e828b862b407e13aea81c432301af
```

The earlier result remains at
`/home/nick/.config/opensmash-deploy/live-netplay-check.json`. Both runs use
synthetic inputs and the production presentation helper; neither establishes
engine determinism or real ROM gameplay.

### Existing site, roster, and engine checks

The original deployment checks on 2026-09-15 established:

- Homepage, `/livez`, netplay config, auth config, session, and character APIs
  returned HTTP 200; public TLS validated and HTTP redirected to HTTPS.
- All 7,322 approved roster objects were published: 2,937,695,460 bytes, with
  GCS checksums and sizes matching the pinned local manifest.
- Chrome fetched, checksum-verified, and decoded all 1,046 tile portraits;
  35 representative images, game/UI bundles, and audio clips also passed.
- Chrome verified all 32 hosted Smash64 engine resources and initialized the
  actual Smash64 and Torch modules without a ROM. Controller heap read/write
  checks passed, including heap-view refresh after memory growth.
- COOP `same-origin`, COEP `credentialless`, and private/no-store API responses
  survived the Worker. The new Melee iframe uses `require-corp` isolation and
  permits framing only by the same origin.
- Firebase advertises email sign-in only. A complete email-link sign-in still
  needs live validation.

Before browser hosting, the legacy original-fighter launcher was also tested
with Fox/Peach selection and a unique WebTransport link up to its ISO picker.
That historical UI check did not provision its legacy engine and is superseded
by the browser-hosting route above.

## What players still supply

An **engine build** is the compiled browser application: Wasm, JavaScript, and
support files. Both engines are built and hosted by the deployment operator;
players do not compile code or assemble workspaces.

**Smash64:** each player supplies a local US v1.0 ROM. The patched browser engine
and Torch extractor were built without a ROM from pinned source using
Emscripten 6.0.2. The compiled multiplayer capability returns version 2. Files
are hosted at `/engine/`; the local package is
`/home/nick/.cache/opensmash-deploy/ssb64-build/source/web-dist`, with build record
`/home/nick/.cache/opensmash-deploy/ssb64-build/runtime-build-records.json`.
Extraction happens locally. Real gameplay still requires validation with that
ROM. See [build instructions](../engines/ssb64/netplay/README.md).

**Melee:** only the host selects a local USA 1.02 ISO/GCM. A generic Dolphin
worker reads that file in the host browser. It is not uploaded to GCP or shared
with guests. The host plays the original roster through Melee's menus and
streams the game to up to three guests. No private server workspace, extracted
`assets/game`, generated `main.dol` build, or conversion service is needed.
See [generic runtime instructions](../engines/melee/runtime/browser-dolphin/README.md).

The preview is not yet qualified with a real ISO. A host still needs to validate
boot, rendered matches, audio, all controller ports, game speed, and guest
input-to-video latency. TURN credentials and a relayed-network test also remain
outstanding. The retained legacy VM/disk can be retired separately after this
qualification; they remain unused and billable for now.

Fighter creation remains disabled. Its worker, conversion inputs, and Tripo/fal
configuration are separate requirements; an OpenAI key alone does not enable
that service. Custom Melee fighters need original rigged source models and are
outside the original-roster browser-hosting preview.

The public roster was published with explicit approval on 2026-09-15. Its base
is `https://storage.googleapis.com/nicknotfun-opensmash-public-assets`. It
contains portraits, metadata, audio, and Smash64 custom fighter/UI bundles, but
no ROM, private game workspace, or original rigged custom-Melee source models.

## Operations

Private configuration:
`/home/nick/.config/opensmash-deploy/deployment.json`.
Use [the deployment guide](README.md) for rollout details. Subsequent website
images must explicitly include **both** runtime packages:

```sh
python3 deploy/gcp/site.py --project nicknotfun-opensmash --region us-central1 \
  --config /home/nick/.config/opensmash-deploy/deployment.json \
  --ssb64-runtime /home/nick/.cache/opensmash-deploy/ssb64-build/source/web-dist \
  --melee-browser-runtime /home/nick/.cache/opensmash-deploy/browser-dolphin/dist-release \
  --apply
```

Omitting a runtime does not inherit it from the previous image. The default
Melee package location inside the image is `/workspace/melee-browser-runtime`.
Check `/api/melee/browser` for runtime availability after rollout.

A relay restart ends its in-memory games; coordinate updates between matches.
Guest departure preserves host-stream games and clears the departed controller;
host departure ends them. The website holds no legacy Melee service token.
Cloud Run scales to zero, but both existing VMs and their disks remain billable.
Stopping the unused legacy Melee VM would reduce compute spend while retaining
disk and IP charges. No automatic shutdown or resource removal occurred.

## Cost estimate

The previous infrastructure estimate uses USD list prices checked on 2026-09-15,
730 running hours/month, before tax. The VM/disk footprint remains unchanged:

| Fixed resource | Monthly estimate |
| --- | ---: |
| e2-small relay | $12 |
| Retained e2-standard-2 legacy Melee VM | $49 |
| 160 GiB balanced persistent disks | $16 |
| Two attached static IPv4 addresses | $7 |
| Total, before usage | About $85 |

Sources: [Compute Engine](https://cloud.google.com/products/compute/pricing/general-purpose),
[persistent disks](https://cloud.google.com/compute/disks-image-pricing),
[external IP and network pricing](https://cloud.google.com/vpc/network-pricing).

The earlier **$90–110/month for light usage** estimate is not a spending cap or
a measured streaming workload forecast. Cloud Run, runtime/asset downloads,
builds, and database operations vary with usage; shared billing-account free
allowances may already be consumed. TURN traffic is not included and the
service is not yet configured. Direct WebRTC media bypasses the website and
GCP gameplay relay. [Cloud Run prices](https://cloud.google.com/run/pricing),
[GCS prices](https://cloud.google.com/storage/pricing),
[Firestore prices](https://cloud.google.com/firestore/pricing).

The Worker can use Cloudflare's Free plan within its limits; the prior quoted
paid Workers plan starts at $5/month. No paid-plan upgrade was requested.
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
Cloudflare does not eliminate Google's origin download charges. Large runtime
or asset downloads can exceed the light-usage estimate. AI generation is disabled
and excluded.
