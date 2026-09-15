# GCP multiplayer services

The website runs separately on Cloud Run behind the Cloudflare Worker. This
package creates dedicated Compute Engine VMs for the direct WebTransport relay
and, optionally, the private Melee conversion service. Use a new billed GCP
project created by `bootstrap.py` (labels `app=opensmash` and
`managed-by=opensmash-deploy`) and set the public website to `https://smash.not.fun`.

The relay is operational without game data. Playable games additionally require
the matching patched browser engine and game assets. Melee's server verifies its
workspace before accepting any work. Provisioning an empty VM leaves its HTTPS
endpoint returning 503 until those files are supplied.

## Build immutable images

Commands assume an authenticated `gcloud`, permission to create resources and
attach service accounts, and an existing project linked to billing. Run from the
repository root. All commands name the project explicitly.

```sh
export OPENSMASH_PROJECT=your-new-project-id
export OPENSMASH_REGION=us-central1
export OPENSMASH_REGISTRY="$OPENSMASH_REGION-docker.pkg.dev/$OPENSMASH_PROJECT/opensmash"
gcloud services enable compute.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iap.googleapis.com --project "$OPENSMASH_PROJECT"
gcloud artifacts repositories create opensmash --repository-format=docker --location "$OPENSMASH_REGION" --project "$OPENSMASH_PROJECT"
export OPENSMASH_RELAY_CONTEXT=$(mktemp -d)
git archive HEAD netplay/relay | tar -x -C "$OPENSMASH_RELAY_CONTEXT"
gcloud builds submit "$OPENSMASH_RELAY_CONTEXT/netplay/relay" --tag "$OPENSMASH_REGISTRY/relay:pilot" --project "$OPENSMASH_PROJECT" --region "$OPENSMASH_REGION"
```

Build contexts come from tracked files at HEAD; commit reviewed code changes
before building. Local untracked files and game workspaces are excluded.

The Cloud Build execution identity needs Artifact Registry Writer on this
repository. Depending on organization defaults, it can also need the standard
Cloud Build source/log bucket permissions. Resolve permission failures on that
identity; do not create or distribute service-account keys.

Build the optional Melee image from a narrow, tracked-code-only context. This
avoids uploading local workspaces, discs, credentials, or unrelated repository
artifacts to Cloud Build:

```sh
export OPENSMASH_MELEE_CONTEXT=$(mktemp -d)
git archive HEAD engines/melee/server engines/melee/requirements.txt engines/melee/opensmash_melee engines/melee/tools engines/melee/runtime engines/melee/web/public/catalog.json | tar -x -C "$OPENSMASH_MELEE_CONTEXT"
gcloud builds submit "$OPENSMASH_MELEE_CONTEXT" --config deploy/gcp/cloudbuild-melee.yaml --substitutions "_IMAGE=$OPENSMASH_REGISTRY/melee:pilot" --project "$OPENSMASH_PROJECT" --region "$OPENSMASH_REGION"
```

Resolve each tag to its digest before rendering the VM configuration:

```sh
export OPENSMASH_RELAY_DIGEST=$(gcloud artifacts docker images describe "$OPENSMASH_REGISTRY/relay:pilot" --format='value(image_summary.digest)' --project "$OPENSMASH_PROJECT")
export OPENSMASH_MELEE_DIGEST=$(gcloud artifacts docker images describe "$OPENSMASH_REGISTRY/melee:pilot" --format='value(image_summary.digest)' --project "$OPENSMASH_PROJECT")
```

## Prepare addresses, then launch

Create `opensmash-melee-token` in Secret Manager before including `--melee-image`.
Its secret value should be at least 32 random ASCII token characters (for example,
64 random hex characters). Generate/store it through a pipe or a root-only file;
never put the value in a command argument, metadata, git, or browser configuration.
The same named secret/version must be mounted on the website as
`MELEE_SERVICE_TOKEN`. Only the Melee VM account receives access from this package;
grant the Cloud Run account access separately.

```sh
node deploy/gcp/deploy.mjs \
  --project "$OPENSMASH_PROJECT" \
  --zone us-central1-a \
  --host smash.not.fun \
  --email operator@example.com \
  --relay-image "$OPENSMASH_REGISTRY/relay@$OPENSMASH_RELAY_DIGEST" \
  --melee-image "$OPENSMASH_REGISTRY/melee@$OPENSMASH_MELEE_DIGEST" \
  --output /tmp/opensmash-gcp
```

Without `--apply`, this only writes `plan.json` and startup scripts for review.
Omit the Melee image option to prepare only the relay. Repeat the same command
with `--apply prepare` to create the isolated VPC/subnet, scoped firewall rules,
service accounts, static IPs, and optional persistent disk. Existing named
resources are retained only after their network/firewall/account/address/disk
configuration matches this plan. The project ownership labels are required for
every applied phase, and data disks additionally require the same ownership
labels. A changed existing VM startup script or image fails the check and requires
an explicit maintenance update; this tool does not overwrite live configuration.

In Cloudflare's `not.fun` zone, create **DNS-only** A records:

| Record | Static address resource | Cloudflare proxy |
| --- | --- | --- |
| `relay.smash.not.fun` | `opensmash-relay` | Off |
| `melee-service.smash.not.fun` | `opensmash-melee` | Off |

Remove conflicting AAAA records for these names. The launch preflight requires
DNS answers to match the corresponding static IPv4 address. After propagation,
repeat the render command with `--apply launch-relay`, then
`--apply launch-melee`. Each VM obtains a publicly trusted Let's Encrypt
certificate using HTTP on port 80. Cloudflare Origin CA certificates are not
suitable for these direct browser connections.

Set these server-side website variables:

```text
OPENSMASH_NETPLAY_URL=https://relay.smash.not.fun
MELEE_SERVICE_ORIGIN=https://melee-service.smash.not.fun
MELEE_SERVICE_TOKEN=<mount the Secret Manager secret>
```

Melee imports accept source-export URLs from the website origin by default.
Use `--asset-origin https://assets.smash.not.fun` only if a separate HTTPS origin
actually serves the `/engine/character-source/<capability>/` exports. Ordinary
baked GCS bundle URLs are not source-export URLs and cannot be imported directly.

The website must preserve COOP/COEP isolation headers. Cloud Run and ordinary
Cloudflare proxying do not carry the relay's direct UDP traffic.

## Persistent Melee inputs

The data disk is 100 GB, separate from the boot disk, and configured with
`auto-delete=no`. The startup script initializes only that named disk and refuses
to format a disk with an existing filesystem/signature or partitions. Existing
ext4 data is mounted in place. The VM uses these paths:

| VM path | Container path | Contents |
| --- | --- | --- |
| `/srv/opensmash-melee/data` | `/data` | Private writable verified conversion workspace |
| `/srv/opensmash-melee/inputs/browser` | `/inputs/browser` | Matching patched browser runtime, read-only |
| `/srv/opensmash-melee/inputs/characters` | `/inputs/characters` | Source fighter library, read-only |
| `/srv/opensmash-melee/inputs/sys` | `/inputs/sys` | Matching Dolphin Sys directory, read-only |

Populate the workspace's `assets/game` and `build/web-game/verified.json` using
your own verified game setup. This package does not obtain or publish game discs.
After provisioning the inputs, run `sudo systemctl start opensmash-melee` over
IAP SSH. The engine checks the verification manifest itself; a file's mere
presence does not make the data valid. Engine runtime gate version 2 is required
for online play. A backup/snapshot policy should be added before relying on
persisted jobs or user-generated fighters.

## Verification and operations

```sh
node --test deploy/gcp/deploy.test.mjs
curl --fail https://relay.smash.not.fun/healthz
gcloud compute ssh opensmash-relay --tunnel-through-iap --zone us-central1-a --project "$OPENSMASH_PROJECT" --command 'sudo systemctl status opensmash-relay; sudo journalctl -u google-startup-scripts.service --no-pager -n 80'
```

The operator needs IAP tunnel access and OS Login administrator permissions.
Firewall rules expose only TCP 80/443 and UDP 443 on the relay, TCP 80/443 on
Melee, and SSH from Google's IAP range. The Melee application binds loopback
inside its host and requires the private token plus an authenticated owner on
every route; Nginx does not log request URLs.

HTTPS health alone does not verify QUIC reachability. Finish with a real
Chromium multi-browser game test against the live relay and matching game assets.
Before game assets are available, room creation/join and WebTransport exchange
can be checked independently, but do not report gameplay as validated.

Certbot renews certificates automatically. The current relay must restart to
load a renewed certificate, ending its in-memory rooms. VM restarts and relay
updates also end active games. Run one relay process: this version has no shared
room state or routing between replicas. Existing VMs are skipped by the deploy
command; deploying a newer image requires an explicit maintenance update of the
startup script and service, not silently changing a live room server.

Defaults are an `e2-small` relay (2 GB RAM, 30 GB boot disk) and an
`e2-standard-2` Melee VM (8 GB RAM, 30 GB boot disk plus 100 GB data). These are
initial sizes, not measured capacity claims. Both have one paid static external
IPv4 address. No instances, disks, or IPs are automatically deleted by this tool.

References: [Compute Engine startup scripts](https://docs.cloud.google.com/compute/docs/instances/startup-scripts/linux),
[persistent disk device names](https://docs.cloud.google.com/compute/docs/disks/disk-symlinks),
[Certbot renewal hooks](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).

## Mirror the pinned public roster

After downloading the roster with `web-prototype/scripts/fetch-baked-characters.mjs`,
copy its verified contents into the new project's public asset bucket:

```sh
node deploy/gcp/mirror-assets.mjs \
  --source-root /home/nick/.cache/opensmash-deploy/baked-roster \
  --project "$OPENSMASH_PROJECT" --bucket "$OPENSMASH_PUBLIC_BUCKET"
```

This preflight checks the checked-in roster manifest, rejects symlinks and
unlisted files, hashes every file, stages only content-addressed objects in its
own temporary directory, and removes that stage when finished. No cloud call is
made until `--apply` is added. Applied runs verify project ownership and bucket
membership, then use authenticated `gcloud storage rsync` with checksums and
immutable cache headers. They never delete destination objects. Gcloud infers
content types from file extensions; the downloaded bytes are decompressed and
are uploaded without a misleading gzip content-encoding. Set the website's
`assetBaseUrl` to `https://storage.googleapis.com/BUCKET` after mirroring.
