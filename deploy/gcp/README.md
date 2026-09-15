# GCP multiplayer services

Cloud Run serves the website and static browser runtimes behind the Cloudflare
Worker. A Compute Engine VM serves the direct WebTransport relay. Melee runs
entirely in the primary player's browser: the host supplies a local ISO, guests
receive video/audio and send inputs, and GCP handles rooms and WebRTC signaling.
Neither the website nor relay needs a server-side ISO or Melee workspace.

**Status, 2026-09-15:** browser-hosted Melee preview is live on Cloud Run revision
`opensmash-site-00005-tml`. The generic four-controller module and actual Chromium
worker loaded from the public website passed disc-free shared-memory checks;
four live browsers passed signaling, media,
controller, and guest-rejoin tests. Actual Melee gameplay and latency remain
unqualified without a host's local ISO. TURN credentials are pending; current
connections use STUN only. The legacy VM is retained and unused, and its service
origin/token have been removed from the website configuration. See
[network diagrams](../ARCHITECTURE.md), [live inventory](../LIVE.md), and
[browser runtime build instructions](../../engines/melee/runtime/browser-dolphin/README.md).

Use a billed GCP project created by `bootstrap.py` with labels `app=opensmash`
and `managed-by=opensmash-deploy`. All commands below run from the repository
root and explicitly name their target project. Applied commands require an
authenticated `gcloud` with permission to create the named resources and attach
service accounts. Do not create or distribute service-account keys.

## 1. Build the relay image

```sh
export OPENSMASH_PROJECT=your-new-project-id
export OPENSMASH_REGION=us-central1
export OPENSMASH_REGISTRY="$OPENSMASH_REGION-docker.pkg.dev/$OPENSMASH_PROJECT/opensmash"
gcloud services enable compute.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iap.googleapis.com --project "$OPENSMASH_PROJECT"
gcloud artifacts repositories create opensmash --repository-format=docker --location "$OPENSMASH_REGION" --project "$OPENSMASH_PROJECT"
export OPENSMASH_RELAY_CONTEXT=$(mktemp -d)
git archive HEAD netplay/relay | tar -x -C "$OPENSMASH_RELAY_CONTEXT"
gcloud builds submit "$OPENSMASH_RELAY_CONTEXT/netplay/relay" --tag "$OPENSMASH_REGISTRY/relay:pilot" --project "$OPENSMASH_PROJECT" --region "$OPENSMASH_REGION"
export OPENSMASH_RELAY_DIGEST=$(gcloud artifacts docker images describe "$OPENSMASH_REGISTRY/relay:pilot" --format='value(image_summary.digest)' --project "$OPENSMASH_PROJECT")
```

Commit reviewed relay changes before archiving HEAD. The Cloud Build identity
needs Artifact Registry Writer and the applicable source/log bucket permissions.
The relay image contains no game runtime or game files. The updated relay must
support `mode:"host-stream"` before the browser Melee route is exposed.

## 2. Provision the direct relay

The browser-hosted deployment needs only the relay VM:

```sh
node deploy/gcp/deploy.mjs \
  --project "$OPENSMASH_PROJECT" \
  --zone us-central1-a \
  --host smash.not.fun \
  --email operator@example.com \
  --relay-image "$OPENSMASH_REGISTRY/relay@$OPENSMASH_RELAY_DIGEST" \
  --output /tmp/opensmash-gcp
```

Without `--apply`, this writes a plan and startup scripts. Repeat with
`--apply prepare` to create the VPC/subnet, scoped firewall rules, service
account, and static address. Existing resources must match the plan and its
ownership checks. Do not include `--melee-image` for browser-hosted Melee.

Create a **DNS-only** Cloudflare A record for `relay.smash.not.fun` pointing to
the `opensmash-relay` static address. Remove conflicting AAAA records. The launch
preflight checks that DNS resolves to the intended IPv4 address. After DNS has
propagated, repeat with `--apply launch-relay`.

The relay obtains a publicly trusted Let's Encrypt certificate through TCP 80.
Both TCP and UDP 443 must reach its container on port 8443. Cloud Run and the
Cloudflare website proxy do not forward this UDP service. Cloudflare Origin CA
certificates are unsuitable for this direct browser connection.

The website configuration uses `relayOrigin` to set
`OPENSMASH_NETPLAY_URL=https://relay.smash.not.fun`. It does not need
`MELEE_SERVICE_ORIGIN` or `MELEE_SERVICE_TOKEN` for browser hosting.

## 3. Package both browser runtimes in the website

Build/package the generic Melee runtime using its
[pinned builder](../../engines/melee/runtime/browser-dolphin/README.md).
No build step takes an ISO. The resulting directory contains generic emulator
JavaScript/Wasm, the four-controller build record, license/corresponding source,
and a manifest of exact file hashes. Only the host later supplies a local ISO.

Validate the package before deployment:

```sh
node web-prototype/server/melee-browser-runtime.js check /path/to/melee-browser-dist
```

Validation rejects symlinks, unlisted/unsupported files, wrong checksums, stale
build records, and missing four-controller capability. It checks that the actual
Wasm capability returns four without starting a game. A valid package is static
website content; it does not belong on the old Melee VM's disk.

Use `mode:"full"` in the website deployment configuration with the existing
Firebase, bucket, relay, cookie-secret, and Turnstile settings. The legacy
`meleeServiceOrigin` and `meleeServiceToken` fields are optional and must either
both be omitted or both supplied. Omit both for browser-only hosting. Configuration
stores numbered Secret Manager references, never secret values.

Include **both runtime options** to preserve the already hosted Smash64 engine:

```sh
python3 deploy/gcp/site.py \
  --project "$OPENSMASH_PROJECT" --region "$OPENSMASH_REGION" \
  --config /private/path/deployment.json \
  --ssb64-runtime /path/to/ssb64-web-dist \
  --melee-browser-runtime /path/to/melee-browser-dist
```

The default is a local preflight/plan; add `--apply` for rollout. Source files
must be tracked for the staging allowlist. Each runtime is a separate named
BuildKit context, checked before upload and again inside its image build.
`with-games` includes both, `with-ssb64` includes Smash64 alone, and
`with-melee-browser` includes Melee alone. A new image does not inherit runtime
files from the currently deployed revision.

The container defaults to
`OPENSMASH_MELEE_BROWSER_ROOT=/workspace/melee-browser-runtime`. Its API reports
availability at `/api/melee/browser`; only verified files are served under
`/melee/browser-runtime/`. The host shell at `index.html` comes from the website's
built `melee-browser-host.html`. Preserve COOP/COEP headers and same-origin iframe
permissions through the Cloudflare Worker.

### Optional Cloudflare TURN

WebRTC tries direct browser connections. Some networks need TURN to relay the
encrypted video, audio, and controller channel. TURN is separate from the Go
signaling service. Cloudflare DNS permissions do not authorize the TURN API.

Configure these website fields together after creating a Cloudflare TURN key:

```json
{
  "cloudflareTurnKeyId": "0123456789abcdef0123456789abcdef",
  "cloudflareTurnSecret": "opensmash-turn:1"
}
```

Replace the example key ID with the actual public 32-hex ID. The secret reference
must identify the numbered Secret Manager version containing its TURN API token.
The deployment injects `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_KEY_API_TOKEN`; the token never enters browser configuration.
`/api/netplay/ice` checks the caller's room capability with the relay's
`/v1/rooms/:id/authorize` endpoint before returning temporary ICE credentials.

Absent TURN configuration, the provider returns Google STUN servers and the
browser attempts a direct connection. Check [LIVE.md](../LIVE.md) for whether
TURN is configured in the current revision.

## 4. Verification and operations

```sh
go -C netplay/relay test -race ./...
node --test web-prototype/server/melee-browser-runtime.test.js web-prototype/server/netplay-ice.test.js web-prototype/infra/pilot-site.test.mjs
python3 -m unittest deploy/gcp/site_test.py
curl --fail https://relay.smash.not.fun/healthz
curl --fail https://smash.not.fun/api/melee/browser
```

The browser streaming harness uses separate Chromium processes, real WebRTC
video/audio and controller traffic, and the production WebTransport adapter.
It needs Playwright plus Chromium; `PLAYWRIGHT_MODULE` can name an installed
module. With no site origin it launches a temporary local relay. After rollout:

```sh
OPENSMASH_SITE_ORIGIN=https://smash.not.fun node netplay/tests/host-stream-smoke.mjs
```

The live harness creates and closes its own test room and tests ordinary TLS,
room admission, signaling, authenticated ICE, media delivery, and guest input.
Generated canvas/audio proves transport only. Qualify a real Melee match with a
host's local ISO before claiming game speed, rendering/audio correctness, or
playable latency. Guests must not be asked for an ISO.

Use IAP and OS Login administrator permissions for VM maintenance. Firewall
rules admit relay TCP 80/443 and UDP 443, with SSH restricted to Google's IAP
range. Certbot renews certificates automatically; the current relay restarts to
load a new certificate. Relay restarts and image updates end its in-memory rooms.
Run one relay process; replicas require shared ownership/routing first.

Ended room snapshots are retained for up to five minutes, but yield capacity to
new games when necessary. Guest departure keeps a host-stream game alive and
neutralizes that guest's input. Host departure ends the room. Lockstep retains
its frozen roster and ends after a participating player disconnects.

The provisioning tool does not overwrite existing VM startup/image settings.
A new relay image needs an explicit maintenance update; it is not silently
applied to a running game server. No instance, disk, or address is automatically
removed. The default relay is `e2-small` with 2 GB RAM and a 30 GB boot disk;
this is a starting configuration, not a measured player-capacity claim.

## 5. Retained legacy Melee service

The existing `opensmash-melee` VM, `melee-service.smash.not.fun` DNS record, and
100 GB retained data disk belong to the previous game-derived runtime and
custom-fighter conversion path. They are unused by browser-hosted Melee and are
pending retirement after browser gameplay qualification. Do not populate that
workspace to enable the new `/melee` route. Keep current inventory and eventual
retirement actions in [LIVE.md](../LIVE.md).

For deployments intentionally retaining the old conversion path, its image can
still be built from a narrow tracked-code context:

```sh
export OPENSMASH_MELEE_CONTEXT=$(mktemp -d)
git archive HEAD engines/melee/server engines/melee/requirements.txt engines/melee/opensmash_melee engines/melee/tools engines/melee/runtime engines/melee/web/public/catalog.json | tar -x -C "$OPENSMASH_MELEE_CONTEXT"
gcloud builds submit "$OPENSMASH_MELEE_CONTEXT" --config deploy/gcp/cloudbuild-melee.yaml --substitutions "_IMAGE=$OPENSMASH_REGISTRY/melee:pilot" --project "$OPENSMASH_PROJECT" --region "$OPENSMASH_REGION"
```

That optional deployment uses `--melee-image`, its own DNS-only address, a
private service token, and the paired legacy website settings. Its Nginx TLS
endpoint forwards to authenticated loopback port 8782. The existing application
returns 503 without its verified private workspace. It is independent of the
new generic runtime package and is not needed for original-roster host streaming.

| Retained VM path | Container path | Legacy purpose |
| --- | --- | --- |
| `/srv/opensmash-melee/data` | `/data` | Private conversion workspace/cache |
| `/srv/opensmash-melee/inputs/browser` | `/inputs/browser` | Game-derived browser runtime |
| `/srv/opensmash-melee/inputs/characters` | `/inputs/characters` | Source fighter library |
| `/srv/opensmash-melee/inputs/sys` | `/inputs/sys` | Matching Dolphin Sys directory |

The disk is separate from the boot disk and has `auto-delete=no`; startup does
not format existing filesystems. The legacy VM defaults to `e2-standard-2`
with 8 GB RAM, a 30 GB boot disk, and the retained 100 GB data disk. Removing its
configuration from the website does not remove these resources or their cost.

## Mirror the pinned public roster

After downloading the roster with `web-prototype/scripts/fetch-baked-characters.mjs`,
copy verified contents into the public asset bucket:

```sh
node deploy/gcp/mirror-assets.mjs \
  --source-root /home/nick/.cache/opensmash-deploy/baked-roster \
  --project "$OPENSMASH_PROJECT" --bucket "$OPENSMASH_PUBLIC_BUCKET"
```

Preflight checks the roster manifest, rejects symlinks/unlisted files, hashes
every file, and stages only content-addressed objects. No cloud call occurs
without `--apply`. Applied runs verify project/bucket ownership and use
checksummed `gcloud storage rsync` with immutable cache headers; they never
delete destination objects. Uploaded bytes are decompressed and have no
misleading gzip content-encoding. Set `assetBaseUrl` to
`https://storage.googleapis.com/BUCKET` after mirroring.
