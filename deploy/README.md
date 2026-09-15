# Deploy OpenSmash on GCP and Cloudflare

The public site is `https://smash.not.fun`. A Cloudflare Worker proxies the
website to Cloud Run. Dedicated GCP VMs run the WebTransport relay and the
private Melee conversion service. Use a new, billing-enabled GCP project.

| Component | Address | Deployment |
| --- | --- | --- |
| Website and API | `smash.not.fun` | Cloud Run through Cloudflare Worker |
| Multiplayer relay | `relay.smash.not.fun` | Compute Engine, direct TCP/UDP 443 |
| Melee service | `melee-service.smash.not.fun` | Compute Engine, HTTPS, private service token |
| Public fighter assets | GCS public bucket | Pinned, content-addressed roster objects |
| Private jobs and assets | Firestore and private GCS bucket | API/service-account access |
| Sign-in and bot checks | Firebase Authentication and Turnstile | Own project and domain |

The deployment tools provision infrastructure; they do not provide game ROMs.
Smash 64 needs a matching patched browser runtime and a player-provided ROM.
Melee needs a verified private game workspace plus its matching patched browser
runtime. The Melee endpoint returns 503 until that workspace is ready. Real
multiplayer gameplay must be validated after those inputs are installed.

See [the deployed resource inventory](LIVE.md) for the current project and prerequisites.

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

Follow [GCP multiplayer services](gcp/README.md) to build digest-pinned images,
prepare static addresses and a persistent Melee disk, and render the VM startup
scripts. Create a random `opensmash-melee-token` in Secret Manager and use the
same secret for the website and Melee service.

Use the [Cloudflare provisioner](cloudflare/README.md) to create a Turnstile
widget for `smash.not.fun` and DNS-only A records for the two service addresses.
Then launch the VMs. DNS must point to the direct VM addresses before certificate
issuance. The deployer refuses conflicting DNS or incompatible existing resources.

The relay can be brought up before the game builds and data are available.
Existing rooms live in one relay process and end on a relay restart.

## 3. Deploy the website and storage

Create a private deployment JSON file following
[the website configuration guide](../web-prototype/infra/pilot-site.md).
Use `mode: "full"`, the Firebase output from step 1, both service origins, and
separate public/private bucket names. Set `firebase.authDomain` to `smash.not.fun`.

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

Supply `--ssb64-runtime /path/to/patched/web-dist` when the verified runtime is
available. Without that option, the website/API can run but Smash 64 gameplay
has no engine image. The runtime is checked before any cloud operation and must
contain the compiled netplay export and extraction tools, without ROM archives.

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
- [Melee private service](../engines/melee/server/README.md).

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
```

Check sign-in, cookie handling, COOP/COEP isolation, roster images and service
errors through the actual public hostname. Then run multiple Chromium browsers
against a shared game link and verified matching game assets. HTTPS health alone
does not validate UDP/WebTransport reachability or deterministic gameplay.

The checked-in configuration tests use mocked providers and local HTTP servers.
Cloud Build, provider permissions, certificate issuance and actual engine gameplay
still need live deployment validation. Before storing unique user creations,
configure backups for the persistent Melee workspace and the durable stores.
