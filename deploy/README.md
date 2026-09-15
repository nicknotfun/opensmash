# Deploy OpenSmash on GCP and Cloudflare

The public site is `https://smash.not.fun`. A Cloudflare Worker proxies the
website to Cloud Run, which serves the website/API and static browser runtimes.
A dedicated GCP VM runs the WebTransport room/signaling relay. Melee runs in the
primary player's browser using a local ISO; guests play through WebRTC video,
audio, and controller input. Use a new, billing-enabled GCP project.

| Component | Address | Deployment |
| --- | --- | --- |
| Website and API | `smash.not.fun` | Cloud Run through Cloudflare Worker |
| Multiplayer relay | `relay.smash.not.fun` | Compute Engine, direct TCP/UDP 443 |
| Browser Melee runtime | `smash.not.fun/melee/browser-runtime/` | Verified generic emulator files served by Cloud Run |
| Optional WebRTC relay | TURN provider endpoints | Encrypted fallback when browsers cannot connect directly |
| Retained legacy Melee service | `melee-service.smash.not.fun` | Existing unused conversion VM; not needed for browser hosting |
| Public fighter assets | GCS public bucket | Pinned, content-addressed roster objects |
| Private jobs and assets | Firestore and private GCS bucket | API/service-account access |
| Sign-in and bot checks | Firebase Authentication and Turnstile | Own project and domain |

Both browser runtimes can be built and hosted without game files. Each Smash64
player selects their own ROM. Only the Melee host selects an ISO; its bytes stay
on that device, and guests need no ISO or emulator. No server-side Melee workspace
or game-derived executable is required for the browser-hosted route.

The generic Melee module, JIT, four-controller bridge, and actual browser worker
have passed disc-free checks. Live rollout status is recorded in [LIVE.md](LIVE.md).
Actual Melee gameplay, audio/rendering, guest latency, and TURN connectivity still
need qualification. The preview uses the original Melee roster. The old Melee
conversion VM remains separate and retained pending browser gameplay validation.

See [the network architecture diagrams](ARCHITECTURE.md) for traffic paths and
[the deployed resource inventory](LIVE.md) for the current project and prerequisites.

## 1. Connect accounts and create the project

Authenticate on the deployment machine:

```sh
gcloud auth login --no-launch-browser
npm exec --yes --package=wrangler@4.131.2 -- wrangler login --device
gcloud billing accounts list
```

Wrangler authorizes Worker/custom-domain and Turnstile operations. General DNS
changes may need an additional Cloudflare token with Zone Read and DNS Edit for
`not.fun`; the [Cloudflare helper](cloudflare/README.md) documents its required
permissions. Keep token values in environment variables or private files.

Use an unused project ID and the intended active billing account:

```sh
python3 deploy/gcp/bootstrap.py \
  --project YOUR_NEW_PROJECT_ID \
  --billing-account YOUR_BILLING_ACCOUNT_ID \
  --domain smash.not.fun
```

This prints a plan without contacting GCP. Add `--apply --output /private/path/firebase.json`
to create the labeled project, link billing, enable APIs, register the Firebase
web app, enable email-link sign-in, and authorize the domain. An existing project
is reused only if it carries this deployment's ownership labels. A different
billing association is never replaced. The output contains public client
configuration, not Google access tokens.

Google and Apple sign-in can be enabled after their provider credentials and
redirect URLs are configured; advertise only working providers in the website.

## 2. Provision the multiplayer services and domain

Follow [GCP multiplayer services](gcp/README.md) to build a digest-pinned relay
image, prepare its static address, and render the VM startup script. Omit the
optional `--melee-image`: browser hosting requires neither that VM's data disk
nor its service token. Deploy a relay version supporting `mode:"host-stream"`.

Use the [Cloudflare provisioner](cloudflare/README.md) to create a Turnstile
widget for `smash.not.fun` and a DNS-only A record for `relay.smash.not.fun`.
Then launch the relay. DNS must point to its direct VM address before certificate
issuance. The deployer refuses conflicting DNS or incompatible existing resources.
Existing legacy Melee resources are retained; changing the browser route does
not automatically remove them.

The relay can be brought up before the game builds and data are available.
Existing rooms live in one relay process and end on a relay restart.

## 3. Deploy the website and storage

Create a private deployment JSON file following
[the browser-runtime deployment guide](gcp/README.md#3-package-both-browser-runtimes-in-the-website).
Use `mode: "full"`, the Firebase output from step 1, `relayOrigin`, and separate
public/private bucket names. Set `firebase.authDomain` to `smash.not.fun`.
Omit `meleeServiceOrigin` and `meleeServiceToken` for browser-only hosting;
those fields are optional as a pair for the separate legacy conversion path.

Create `opensmash-cookie-secret` and `opensmash-turnstile-secret` in Secret Manager.
The cookie secret should be at least 32 random bytes; the Turnstile secret comes
from the widget provisioner. Config JSON contains numbered Secret Manager
references such as `opensmash-cookie-secret:1`, never secret values.

```sh
python3 deploy/gcp/site.py \
  --project YOUR_NEW_PROJECT_ID --region us-central1 \
  --config /private/path/deployment.json
```

Review the plan, then add `--apply`. The tool uploads a restricted source tree,
uses Cloud Build, provisions owned GCS/Firestore resources, scopes the API's IAM
access, and deploys Cloud Run with public ingress for the Worker. Configuration
and secret values are excluded from the image build context.

Include the verified engine packages when they are available:

```sh
python3 deploy/gcp/site.py \
  --project YOUR_NEW_PROJECT_ID --region us-central1 \
  --config /private/path/deployment.json \
  --ssb64-runtime /path/to/ssb64-web-dist \
  --melee-browser-runtime /path/to/melee-browser-dist
```

Pass **both runtime options** to retain both engines in the next image; runtimes
are not inherited from the previous deployment. Without an engine's option, the
website/API can run but that engine is unavailable. Preflight rejects game
archives and symlinks. The Melee manifest, every packaged hash, build record, and
actual four-port Wasm capability are checked before upload and inside the build.
Its source archive and license are served alongside the generic runtime.

### Optional Cloudflare TURN

Some networks need TURN to connect the host and guests. Configure the paired
`cloudflareTurnKeyId` and `cloudflareTurnSecret` fields after creating a Cloudflare
TURN key. The first is its public 32-hex ID; the second is a numbered Secret
Manager reference, such as `opensmash-turn:1`, holding its TURN API token.
The website verifies a connected room capability before returning temporary ICE
credentials. DNS-edit authorization does not grant TURN API access.

Without TURN, the browsers use STUN and attempt a direct connection. Follow the
[GCP TURN setup](gcp/README.md#optional-cloudflare-turn) and test a relayed route
before claiming support across restrictive networks. Keep all API token values
out of configuration JSON, git, command arguments, and browser bundles.

### Publish the website hostname

Set `CLOUD_RUN_ORIGIN` to the returned service URL in
[wrangler.jsonc](cloudflare/wrangler.jsonc), then deploy:

```sh
npm exec --yes --package=wrangler@4.131.2 -- wrangler deploy \
  --config deploy/cloudflare/wrangler.jsonc
```

Cloudflare owns HTTPS for the website hostname. The Worker preserves cookies,
streams and browser isolation headers, and bypasses shared caching for origin
responses. Public content-addressed assets remain separately cacheable.

## 4. Seed the existing fighters and enable gameplay

The repository's manifest contains 1,046 published fighters. Fetch that exact
roster with byte-count and SHA-256 verification:

```sh
node web-prototype/scripts/fetch-baked-characters.mjs \
  --bucket smash-the-weights-fighter-assets \
  --output /private/path/baked-roster
```

Mirror the verified, manifest-listed objects into the new public bucket:

```sh
node deploy/gcp/mirror-assets.mjs \
  --source-root /private/path/baked-roster \
  --bucket YOUR_PUBLIC_ASSET_BUCKET --project YOUR_NEW_PROJECT_ID --apply
```

Omit `--apply` for a complete local checksum preflight without cloud calls.
Point `assetBaseUrl` at this bucket after mirroring. The tool copies only pinned
roster objects and never deletes destination objects. Follow the engine-specific
build and setup instructions:

- [Smash 64 netplay build](../engines/ssb64/netplay/README.md).
- [Generic browser Melee build](../engines/melee/runtime/browser-dolphin/README.md).

The mirrored custom-fighter assets remain available for existing asset flows.
Browser-hosted Melee initially uses its original ISO roster; it does not depend
on the legacy custom-fighter conversion service.

An OpenAI key is unnecessary for playing the existing roster. The current fighter
creation pipeline additionally requires its Tripo and fal/MiniMax configuration,
a working worker and conversion assets. Keep creation disabled until that worker
has been deployed and tested; adding an OpenAI key alone does not complete it.

## Verify before calling the deployment playable

```sh
node --test deploy/cloudflare/*.test.mjs deploy/gcp/*.test.mjs \
  web-prototype/infra/pilot-site.test.mjs engines/melee/tests/server.test.mjs
python3 -m unittest discover -s deploy/gcp -p '*_test.py'
curl --fail https://relay.smash.not.fun/healthz
curl --fail https://smash.not.fun/api/netplay/config
curl --fail https://smash.not.fun/api/melee/browser
```

Check sign-in, cookie handling, COOP/COEP isolation, runtime availability, and
roster images through the actual public hostname. The browser streaming harness
uses separate Chromium processes and real WebTransport/WebRTC; with Playwright
installed it can exercise the deployed room, relay, ICE, video/audio, and input
paths without any game data:

```sh
OPENSMASH_SITE_ORIGIN=https://smash.not.fun node netplay/tests/host-stream-smoke.mjs
```

Generated media and successful worker startup do not validate a Melee match.
Complete a real match using only the host's local ISO, verify guest controls and
unplug/rejoin behavior, and measure game speed and input-to-video latency. Test
TURN on a route requiring relay as well as direct WebRTC. Smash64 remains
lockstep and requires matching local ROMs on every participating device.

HTTPS health alone does not establish UDP reachability, gameplay, or deterministic
simulation. Provider permissions and certificates need live checks; tests cover
both mocked-provider failure paths and actual local QUIC/media/controller
exchange. Before enabling unique user creations, configure backups for the
stores those creation services use. Legacy Melee VM retirement is a separate
operation after browser gameplay qualification.
