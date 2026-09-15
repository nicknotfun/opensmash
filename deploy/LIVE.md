# smash.not.fun deployment

Infrastructure provisioned on 2026-09-15 in the new GCP project
`nicknotfun-opensmash` (project number `887140158350`). Region: `us-central1`.
Cloudflare account: Cloudy; zone: `not.fun`.

## Resources

| Resource | Configuration |
| --- | --- |
| Website | Cloud Run `opensmash-site`, 1 vCPU / 1 GiB, 0–3 instances; Cloudflare Worker `opensmash-site` |
| Relay | `opensmash-relay`, `us-central1-a`, e2-small, 30 GiB balanced boot disk, `136.64.109.100` |
| Melee | `opensmash-melee`, `us-central1-a`, e2-standard-2, 30 GiB balanced boot disk, `34.56.102.20` |
| Melee data | `opensmash-melee-data`, 100 GiB balanced persistent disk, retained independently of the VM |
| Network | Dedicated `opensmash` VPC and regional subnet; SSH through Google IAP |
| Public assets | `gs://nicknotfun-opensmash-public-assets` |
| Private assets | `gs://nicknotfun-opensmash-private-assets` |
| Database | Firestore Native `(default)`, room expiry policy on `handoffRooms.expireAt` |
| Authentication | Firebase email-link provider, own-domain auth helper, Cloudflare Turnstile |
| Images | Artifact Registry `opensmash` and `opensmash-site` |

`relay.smash.not.fun` and `melee-service.smash.not.fun` use DNS-only A records.
The relay accepts direct WebTransport over UDP 443 and REST over HTTPS 443.
Both VMs obtain and renew publicly trusted Let's Encrypt certificates.
The relay has persistent QUIC socket-buffer settings in its startup template.

Private deployment inputs live on devy under
`/home/nick/.config/opensmash-deploy/` with restricted permissions. API and Melee
credentials are numbered Secret Manager versions; token values are not stored
in this repository. The runtime service accounts have separate responsibilities.

### Pinned service images

```text
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash/relay@sha256:cc8df4cfe75bd736dfc0afa94ca799a2a6bf980608e34746ed536220b06d1be3
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash/melee@sha256:f6bd2a95d27e0f4cd3b72a7c7d11c2d8d69742635ded03f463a5a7fbbaa3feae
```

The website image includes the ROM-free Smash 64 runtime and original-Melee
launcher. It built successfully in Cloud Build
`2d34b05f-9dea-401e-9574-4d7dd21d2dae` and is running as Cloud Run revision
`opensmash-site-00004-8n7`. Its origin is
`https://opensmash-site-oxrdjed7ra-uc.a.run.app`.

```text
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash-site/website@sha256:6d4804e37283e8cff113e3b2093a40ecefd55fcce8b26b527bb8406a83d7232c
```

## Live verification

Verified through `https://smash.not.fun` on 2026-09-15:

- Homepage, `/livez`, netplay config, auth config, session and character APIs: HTTP 200.
- All 7,322 approved roster objects are published: 2,937,695,460 bytes, with GCS checksums and sizes matching the pinned local manifest.
- Chrome fetched, checksum-verified and decoded all 1,046 tile portraits; 35 representative full/medium images, game bundles, UI bundles and audio clips also passed.
- Original Melee UI: selected Fox and Peach, created a unique game link, joined over WebTransport, and reached the ISO picker with both choices preserved. No source-import or conversion requests occurred; the temporary room was then closed.
- Chrome verified all 32 hosted engine resources against the packaged bytes and initialized the actual Smash 64 and Torch modules without a ROM. Both controller heap views passed write/read checks; no browser errors occurred.
- Public TLS validation succeeds; HTTP redirects to HTTPS.
- COOP `same-origin`, COEP `credentialless`, and private/no-store API responses survive the Worker proxy.
- Firebase advertises email sign-in only; an actual email-link sign-in has not been tested.
- Cloudflare Worker version: `b29a1b46-ef2c-44db-9acc-8e6824c86085`.

The [live smoke harness](../netplay/tests/live-smoke.mjs) passed against the real
public site and relay using four Chromium 151 sessions and ordinary public
certificate validation. All four received the same 180 ordered input frames;
a fifth player was rejected. One client completed all ticks with no display
callbacks. Disconnecting a player stopped all peers and ended the test room.
This test exchanges synthetic inputs and exercises the production presentation
helper. It does not load a ROM or validate either game engine's determinism.

The local result is saved in
`/home/nick/.config/opensmash-deploy/live-netplay-check.json`. Its input-frame hash:

```text
4a4f1ccd16546746ccc112ca2a7f7f38cf4e828b862b407e13aea81c432301af
```

## Gameplay prerequisites

An **engine build** is the compiled browser application (`.wasm` plus JavaScript
and support files). The deployment operator builds and hosts it. Players do not
supply an engine build.

**Smash 64:** the patched engine and browser Torch extractor were built from
pinned source without a ROM, using Emscripten 6.0.2. Both modules initialize, and
the compiled multiplayer capability returns version 2. Controller memory writes and
heap-view refresh after memory growth pass against the actual compiled module.
These files are now hosted
at `/engine/` on the public site. The local runtime package is
`/home/nick/.cache/opensmash-deploy/ssb64-build/source/web-dist`; its build record
is `/home/nick/.cache/opensmash-deploy/ssb64-build/runtime-build-records.json`. Each player supplies a Smash 64 US v1.0 ROM
in the browser. Game data is extracted locally. Real gameplay validation still
requires that ROM. See [build instructions](../engines/ssb64/netplay/README.md).

**Melee:** the current runtime compiles the game's executable (`main.dol`) from
an unmodified USA 1.02 ISO/GCM during its one-time build. A *verified workspace*
means the extracted disc files in `assets/game` plus their checked hash receipt
at `build/web-game/verified.json`. The operator generates these from the ISO;
players do not assemble those directories. Selecting a disc on the website keeps
it in the browser and does not provision the server. No ISO has been supplied
for this deployment, so the Melee runtime/workspace remain unbuilt and its
service intentionally returns HTTP 503.

The shared launcher now supports [original Melee fighters](../engines/melee/docs/ORIGINAL_FIGHTERS.md)
under **Settings → Gameplay Options**. An all-original lineup skips custom source
imports and costume conversion. Custom Melee fighters additionally require their
original rigged source models; these cannot be recovered from the published
Smash 64 bundles. Providing the ISO lets the operator handle Melee's remaining
build/provisioning work for the original roster.

Fighter creation is disabled. The existing creation pipeline also needs its
worker, conversion inputs and Tripo/fal configuration; an OpenAI key alone does
not complete that service.

The pinned public roster was published with explicit approval on 2026-09-15:
1,046 fighters, 7,322 files, 2,937,695,460 bytes. Its public base is
`https://storage.googleapis.com/nicknotfun-opensmash-public-assets`. All stored
object sizes and checksums match the manifest-verified files. The roster includes
portraits, metadata, audio, and Smash 64 custom fighter/UI bundles. It contains
no ROM, private game workspace, or original rigged source models for the custom
Melee roster.

## Operations

Use [the deployment guide](README.md) for repeatable rollout commands. Current
private configuration: `/home/nick/.config/opensmash-deploy/deployment.json`.

Include the runtime explicitly on subsequent website deployments:

```sh
python3 deploy/gcp/site.py --project nicknotfun-opensmash --region us-central1 \
  --config /home/nick/.config/opensmash-deploy/deployment.json \
  --ssb64-runtime /home/nick/.cache/opensmash-deploy/ssb64-build/source/web-dist --apply
```

A relay restart ends its in-memory games. Coordinate relay updates between
matches. The Melee converter uses one process and a persistent local workspace;
configure backups before storing unique user-created content there.
Cloud Run scales to zero; the two game VMs and their disks remain billable while
running. Stopping an unused Melee VM reduces compute spend but retains disk and
IP charges. No automatic shutdown policy has been enabled.

## Cost estimate

USD list prices checked on 2026-09-15, 730 running hours/month, before tax:

| Fixed resource | Monthly estimate |
| --- | ---: |
| e2-small relay | $12 |
| e2-standard-2 Melee | $49 |
| 160 GiB balanced persistent disks | $16 |
| Two attached static IPv4 addresses | $7 |
| Total, before usage | About $85 |

Sources: [Compute Engine](https://cloud.google.com/products/compute/pricing/general-purpose),
[persistent disks](https://cloud.google.com/compute/disks-image-pricing),
[external IP and network pricing](https://cloud.google.com/vpc/network-pricing).

Allow approximately **$90–110/month for light usage**. This is an estimate, not a
spending cap. Cloud Run, storage/downloads, builds and database operations vary
with usage; free allowances may be shared with other projects on the billing
account. [Cloud Run prices](https://cloud.google.com/run/pricing),
[GCS prices](https://cloud.google.com/storage/pricing),
[Firestore prices](https://cloud.google.com/firestore/pricing).

The Worker can use Cloudflare's Free plan within its limits; a paid Workers
subscription starts at $5/month. No paid-plan upgrade was requested here.
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
Cloudflare does not eliminate Google's origin bandwidth charges. Large downloads
can exceed this estimate. AI generation is disabled and is excluded from it.
