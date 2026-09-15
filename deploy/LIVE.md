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

The website image built successfully in Cloud Build
`81cdc724-b4c6-4733-9fc4-9249f1b02b3e` and is running as Cloud Run revision
`opensmash-site-00001-nq2`. Its origin is
`https://opensmash-site-oxrdjed7ra-uc.a.run.app`.

```text
us-central1-docker.pkg.dev/nicknotfun-opensmash/opensmash-site/website@sha256:72182744ac0f9cbd4fe872397c66bc28655769a12b5be3d6a8a6910298130cff
```

## Live verification

Verified through `https://smash.not.fun` on 2026-09-15:

- Homepage, `/livez`, netplay config, auth config, session and character APIs: HTTP 200.
- 1,046 roster entries; the sample portrait returns 404 while asset publication is pending.
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

The infrastructure does not contain game ROMs or a verified Melee workspace.
The Melee endpoint intentionally returns HTTP 503 with
`Melee game assets are not provisioned` until the private workspace is installed.
Smash 64 needs the patched browser runtime built according to
[its build instructions](../engines/ssb64/netplay/README.md), then deployed with
`deploy/gcp/site.py --ssb64-runtime /path/to/web-dist`.
Melee needs the [verified workspace and matching browser inputs](../engines/melee/server/README.md)
on its persistent volume. These inputs must stay outside source control.

Fighter creation is disabled. The existing creation pipeline also needs its
worker, conversion inputs and Tripo/fal configuration; an OpenAI key alone does
not complete that service.

The pinned public roster has been downloaded and checksum-verified locally:
1,046 fighters, 7,322 files, 2,937,695,460 bytes. Publishing those files to the new
public bucket is pending explicit approval after automatic review blocked the
upload. No game ROM or private game workspace is part of that roster.

## Operations

Use [the deployment guide](README.md) for repeatable rollout commands. Current
private configuration: `/home/nick/.config/opensmash-deploy/deployment.json`.

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
