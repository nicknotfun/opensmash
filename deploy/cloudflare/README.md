# Cloudflare website entrypoint

This Worker serves `https://smash.not.fun` from the OpenSmash website on Cloud Run.
The Cloudflare account must own the active `not.fun` zone. The website container
and Cloud Run service are configured separately under `deploy/`.

## Configure and deploy

1. Deploy the Cloud Run website service and obtain its HTTPS `*.run.app` URL.
2. Set `vars.CLOUD_RUN_ORIGIN` in `wrangler.jsonc` to that origin, without a path.
   The empty value intentionally returns HTTP 503 until configured.
3. Authenticate Wrangler in the intended Cloudflare account (`npx wrangler login`),
   then deploy from this directory with `npx wrangler deploy`.

The custom-domain route creates the site DNS record and certificate. Any existing
conflicting CNAME for `smash.not.fun` must be reviewed before replacing it.
`workers.dev` and preview URLs are disabled. No API credentials belong in this
configuration or repository.

Cloud Run must permit the Worker to invoke the website. This initial proxy does
not add Google IAM authentication or an origin shared secret; the service's
`run.app` URL is also reachable directly. Application authentication still applies.
Set `PUBLIC_ORIGIN=https://smash.not.fun` on the website container so the Melee
gateway accepts the public browser origin while Cloud Run receives its own host.
The Worker replaces forwarded host/protocol headers and the forwarded client IP
with Cloudflare's `CF-Connecting-IP`, and preserves the browser's `Origin` header.

## Request and cache behavior

HTTP requests to the site hostname redirect to HTTPS.
Methods, request bodies, paths, queries, cookies, byte ranges, and response
isolation headers pass through. Redirects are returned to the browser without
forwarding credentials to their target. Redirects back to the Cloud Run origin
are rewritten to the public site hostname. Response bodies stream through.

The Worker bypasses Cloudflare's origin cache and sets CDN no-store headers.
API and authenticated responses also receive `Cache-Control: private, no-store`.
Public asset browser-cache headers are preserved. Do not enable Workers Cache or
add a rule overriding these protections. A separate public asset hostname can
later serve character bundles from R2.

The WebTransport relay requires a separate DNS-only hostname pointing directly
to its GCP VM; it does not pass through this Worker. The initial website can be
deployed before that relay or any ROM-derived engine assets are available.

## Tests

From the repository root:

```sh
node --test deploy/cloudflare/worker.test.mjs
```

These tests exercise the proxy with Node's standard Request/Response objects and
a mock origin. Deployment verification must additionally check the real custom
domain, Cloud Run origin, isolation headers, and login/API behavior.

## References

- [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Worker request and redirect behavior](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Fetch cache controls](https://developers.cloudflare.com/workers/runtime-apis/fetch/)


## Provision Turnstile and service DNS

`provision.mjs` uses the Cloudflare API directly. Supply an account-scoped
`CLOUDFLARE_API_TOKEN` in the process environment, or an absolute `--token-file`
pointing to a private regular file (mode `0600`). Do not pass token values on the
command line. The token needs Account Read and Turnstile Edit for the selected
account, plus Zone Read and DNS Edit for `not.fun` when DNS records are requested.
Wrangler's OAuth permissions do not necessarily include DNS Edit.

The helper manages only the widget named `opensmash:smash.not.fun` and the two
service hostnames below. It checks that the account owns an active `not.fun` zone.
The widget permits only `smash.not.fun`, uses managed challenges, and grants no
zone-wide challenge clearance. Cloudflare's domain rules also permit subdomains
of that hostname. Existing conflicting DNS records are refused, and exact matches
are reused. Duplicate widgets with the owned name require manual resolution.

Create a private output directory outside the repository, then preview using the
account ID and static VM IPs selected for this deployment:

```sh
node deploy/cloudflare/provision.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --token-file /home/nick/.config/opensmash/cloudflare-token \
  --output /home/nick/.config/opensmash/cloudflare.json \
  --relay-ip "$OPENSMASH_RELAY_IP" \
  --melee-ip "$OPENSMASH_MELEE_IP" \
  --dry-run
```

The dry run performs metadata reads and prints the intended changes, without
retrieving widget secrets or writing files. Remove `--dry-run` to apply the same
configuration. Either IP argument can be omitted to leave that hostname alone;
omit both to configure only Turnstile. The website custom domain still belongs
to `wrangler deploy`, independently of this helper.

The output JSON contains `turnstile.sitekey` and `turnstile.secret`. It is written
atomically with mode `0600` and never printed. Import the secret into the website's
Secret Manager configuration and use the sitekey in its public Turnstile config.
An existing output must belong to this same deployment; unrelated files and
symlinks are refused. The helper does not rotate widget secrets. If DNS creation
fails after a widget was created, its credentials are already preserved in the
output so a corrected rerun can continue safely.

Mocked provisioning and proxy tests:

```sh
node --test deploy/cloudflare/*.test.mjs
```

- [Turnstile widget API](https://developers.cloudflare.com/api/resources/turnstile/)
- [DNS records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
