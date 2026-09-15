# Browser WebTransport smoke test

This harness launches the actual Go relay and imports the website's shared
`NetplaySession` in four isolated Chromium browser contexts. It exercises HTTPS
room creation/joining, rejects a fifth player, freezes the roster, readies all
players with matching content fingerprints, and compares 180 confirmed ticks of
distinct controller inputs across all four browsers. It then disconnects one
player and verifies that every remaining session stops accepting simulation work.

The engine loop is synthetic: this validates browser/QUIC/client interoperability
and input delivery, not Smash 64 or Melee determinism. No ROM is needed.

Requirements: Node 22+, Go 1.25+, OpenSSL, and Chromium's Linux system libraries.
Dependencies and Playwright's browser revision are pinned by `package-lock.json`.

```sh
cd netplay/tests
npm ci
npx playwright install chromium
npm test
```

To use an existing browser instead of downloading Playwright's Chromium:

```sh
CHROME_BIN=/usr/bin/google-chrome npm test
```

`PLAYWRIGHT_MODULE` can point to an absolute Playwright module path when its
package is installed outside this directory. `GOCACHE`, `GOMODCACHE` and
`PLAYWRIGHT_BROWSERS_PATH` support external caches. By default the Go caches and
all temporary binaries/certificates live in the system temporary directory.
`CHROMIUM_EXECUTABLE` is also accepted as an alias for `CHROME_BIN`.

The `relay` job in `.github/workflows/netplay.yml` runs the Go race tests,
installs the pinned Playwright Chromium with its system dependencies, and runs
this same smoke test on pull requests.

The test uses only local TCP/UDP sockets. It generates a fresh ECDSA certificate
valid for two days. Node verifies that certificate explicitly; the test Chrome
process trusts only that certificate's SPKI via a launch flag. No global TLS
bypass is enabled. A test-only transport factory also supplies WebTransport's
standard `serverCertificateHashes` with the certificate's exact SHA-256 hash;
Chrome applies separate certificate policy to WebTransport. The production
client and certificate configuration are unchanged. Temporary services,
certificates and browser contexts are removed after the run.

Success prints the browser version, player/tick count, common SHA-256 frame hash,
and the admission/disconnection assertions. A browser lacking compatible
WebTransport support fails the test instead of silently using another transport.

Verified with Google Chrome 151.0.7922.75: all four clients produced frame hash
`4a4f1ccd16546746ccc112ca2a7f7f38cf4e828b862b407e13aea81c432301af`
over 180 ticks; fifth-player rejection and disconnect termination passed.
