# Standalone Cloud Run pilot website

This package builds the fork directly from its repository root. Its default
image runs the website without either game runtime, a ROM/disc, an AI worker,
or a persistent database. Character generation stays disabled and no multiplayer
relay is advertised until full-service configuration is supplied.
The relay and Melee preparation service deploy separately. The relay can run
before game builds are available; playable matches still require verified engines
and each engine's required game data.

## Build

From the repository root, using Docker with BuildKit:

```sh
docker build -f web-prototype/docker/pilot-api.Dockerfile --target pilot -t opensmash-site .
node --test web-prototype/infra/pilot-site.test.mjs
```

The image includes the WebTransport bridge and all browser-side Melee helper
imports. It installs locked JavaScript dependencies and builds Vite in a separate
stage. No engine compilation or download takes place. The production process
runs as the unprivileged `node` user and binds Cloud Run's `PORT` on all interfaces.

## Public configuration and secret references

Create a local JSON configuration (replace every illustrative identifier):

```json
{
  "projectId": "your-new-project",
  "region": "us-central1",
  "siteOrigin": "https://smash.not.fun",
  "assetBaseUrl": "https://storage.googleapis.com/your-public-assets",
  "firebase": {
    "apiKey": "YOUR_FIREBASE_PUBLIC_WEB_API_KEY",
    "appId": "YOUR_FIREBASE_WEB_APP_ID",
    "authDomain": "smash.not.fun",
    "providers": ["email"]
  },
  "turnstileSiteKey": "YOUR_PUBLIC_WIDGET_KEY",
  "cookieSecret": "opensmash-cookie-secret:1",
  "turnstileSecret": "opensmash-turnstile-secret:1"
}
```

The Firebase web values and Turnstile site key are public identifiers. Put the
actual cookie signing secret and Turnstile verification secret in Secret Manager;
the JSON contains only the secret name and a numbered version. Grant the Cloud
Run runtime service account access to those two secrets. The production server
retains its existing Firebase and Turnstile requirements even while creation is
disabled. Enable the listed Firebase sign-in providers and authorize
`smash.not.fun` as a Firebase Authentication domain.

Generate Cloud Run inputs without printing any secret values:

```sh
node web-prototype/infra/pilot-site.mjs check-config /path/to/pilot-config.json
node web-prototype/infra/pilot-site.mjs env /path/to/pilot-config.json > /tmp/opensmash-site-env.json
node web-prototype/infra/pilot-site.mjs secrets /path/to/pilot-config.json
```

Pass the generated JSON as `gcloud run deploy --env-vars-file` and the last
command's secret references as `--set-secrets`. Set minimum instances to zero
and maximum instances to three initially. The default site does not persist jobs,
files or handoff rooms across Cloud Run restarts. This is appropriate while
creation and gameplay are unavailable; enable Firestore and separate private/public
GCS buckets before enabling features that require durable state. Do not attach
an OpenAI API key to this pilot.

## Execute a rollout

After project/billing, Firebase and Turnstile bootstrap, use the checked-in
rollout command from the repository root:

```sh
python3 deploy/gcp/site.py --project YOUR_PROJECT --region us-central1 \
  --config /path/to/pilot-config.json
python3 deploy/gcp/site.py --project YOUR_PROJECT --region us-central1 \
  --config /path/to/pilot-config.json --apply
```

The first command emits a plan without calling GCP. `--apply` stages only
allowlisted tracked source files plus the known packaging files, builds with
Cloud Build, and deploys the `opensmash-site` Cloud Run service. The staged source
excludes repository history, dependencies, local configuration, credentials and
game data. Cloud Run environment JSON and secret references stay outside the
uploaded build context. The rollout creates dedicated API/build identities and
scopes storage, secret and worker-invoker IAM to their named resources; Firebase
Authentication and Firestore roles are project-scoped. It does not fetch secret
values. Its final output includes the Cloud Run origin for the Cloudflare Worker.

The target project and existing resources must carry `app=opensmash` and
`managed-by=opensmash-deploy` labels before the script modifies them. Dedicated
service accounts must carry its ownership description. Missing/disabled secrets,
inaccessible resources and conflicting Firestore locations halt the rollout;
permission errors never count as a missing resource. The default database is
created only when absent; existing databases retain their settings. This command
does not configure billing, DNS, Firebase providers, Turnstile widgets, the
relay, Melee preparation, the AI worker, or upload the public baked asset set.

## Full-service configuration

Add these fields to the same config once the dependent service origins and token
reference are known. The rollout provisions missing durable data stores:

```json
{
  "mode": "full",
  "privateBucket": "your-new-project-private-assets",
  "publicBucket": "your-new-project-public-assets",
  "relayOrigin": "https://relay.smash.not.fun",
  "meleeServiceOrigin": "https://melee-service.smash.not.fun",
  "meleeServiceToken": "opensmash-melee-token:1"
}
```

Full mode switches jobs and ROM handoff signaling to Firestore and object files
to separate private/public GCS buckets. Create the default Firestore database and
enable its `handoffRooms.expireAt` TTL policy. Grant the API runtime identity
`roles/datastore.user` on the project, appropriate object access to the two
buckets, and access to the Melee token secret. Only the public bucket's published
assets should be readable without authentication. Set its CORS policy for the
website and preserve content hashes, content types, gzip encodings and immutable
cache metadata while copying the baked asset objects.

The API signs requests to Melee with the shared token; the Melee service must use
the same secret. Keep that service private behind its authenticated HTTPS
endpoint. The relay uses its own HTTPS endpoint with TCP and UDP 443 available,
a browser-trusted certificate, and the exact website origin allowlist. Configure
Cloudflare DNS-only for the relay's direct QUIC endpoint.

Playing with the existing roster requires no OpenAI key. To add optional AI
fighter creation after deploying its worker, add these separate fields:

```json
{
  "fighterWorkerOrigin": "https://YOUR-WORKER-SERVICE.run.app",
  "fighterWorkerService": "opensmash-fighter-worker",
  "openaiSecret": "opensmash-openai:1"
}
```

Supplying a real deployed worker enables creation and moderation. The API obtains Google service-account ID tokens for
that worker; grant its runtime identity Cloud Run invoker on the worker service.
Keep the worker authenticated. Supply `openaiSecret` for the API's submission
moderation step, and give the worker its generation key, Firestore and bucket
permissions, and required generation/conversion tools. Secrets are injected at
runtime, never embedded in the image or public environment JSON. Omitting the
worker keeps creation disabled even in full mode and needs no OpenAI key.

Full mode does not provide an engine or manufacture game data. Use the
`with-ssb64` image target for a verified patched Smash 64 build. Melee still needs
its runtime, private preparation service, and required disc-derived inputs.
Keep gameplay unavailable until those prerequisites have been tested.

## Roster asset source

The committed `config/baked-assets.json` already contains the public roster's
metadata and content hashes. The server can display its catalog without local
engine assets. Portraits and other files still need an actual HTTPS asset source;
`assetBaseUrl` must serve the manifest's `baked/v1/objects/<sha256>/<filename>` keys.
The repository README documents the upstream public source bucket
`smash-the-weights-fighter-assets`. Using
`https://storage.googleapis.com/smash-the-weights-fighter-assets` keeps that
external dependency. To make hosting fully independent, copy the verified
content-addressed objects to your own GCS bucket or Cloudflare R2 and set this
base to its public HTTPS origin. No Nintendo ROM or extracted game archive
belongs in that public asset store.

## Add a patched Smash 64 runtime later

The deployment operator builds and hosts this runtime from the pinned open-source
code; no ROM is needed for that build. Players provide their own Smash 64 US v1.0
ROM in the browser, where Torch extracts the game assets locally. Build according
to `engines/ssb64/netplay/README.md`, then provide only its packaged `web-dist`
directory as a named BuildKit context:

```sh
node web-prototype/infra/pilot-site.mjs check-runtime /path/to/web-dist
docker build -f web-prototype/docker/pilot-api.Dockerfile --target with-ssb64 \
  --build-context ssb64-runtime=/path/to/web-dist -t opensmash-site-with-ssb64 .
```

Preflight requires the engine, extraction tools, supporting files, and a real
compiled netplay capability export. It rejects symlinks and known ROM/disc/archive
extensions, with one exact exception: `files/f3d.o2r` must contain only the eleven
open-source shaders pinned by `config/ssb64-f3d-shaders.json`, with every file size
and checksum matching. Renaming a game archive does not pass that check.
This is a packaging check; the browser still verifies the capability
version and actual two-browser gameplay must pass before enabling gameplay.
The cloud rollout accepts the same optional runtime directory:

```sh
python3 deploy/gcp/site.py --project YOUR_PROJECT --region us-central1 \
  --config /path/to/full-config.json --ssb64-runtime /path/to/web-dist --apply
```

Preflight validates the original and staged runtime before any cloud calls,
copies only its packaged files, and includes their content hashes in the image
tag. This switches Cloud Build to the `with-ssb64` target and supplies its named
context through Buildx. Omitting the runtime still deploys the services without
an engine; `mode=full` alone does not include game binaries.

Neither the validator nor the image enables it automatically. Configure the
public WebTransport relay origin and its exact website origin allowlist when
turning gameplay on. Melee additionally needs its rebuilt runtime and private
authenticated preparation service.

## Verification boundary

Node tests cover production configuration, disabled pilot features, engine
capability/export checks, missing extraction inputs, and accidentally included
ROM archives or symlinks. The Docker image must still be built with a Docker
engine and deployed against the actual Firebase/Turnstile configuration before
claiming production readiness. No sample secret values are usable credentials.
