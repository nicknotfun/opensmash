# OpenSmash WebTransport relay

This Go service coordinates rooms and exchanges controller input over an ordered
WebTransport stream (HTTP/3 over QUIC). It also serves its room API over ordinary
HTTPS on the same port. Browser clients contact this relay directly; the Node
website supplies its public HTTPS origin through the netplay configuration.

The relay starts each simulation tick only after receiving that tick from every
participating player. It broadcasts the same four controller pads to everyone.
This is reliable lockstep: latency or packet loss pauses progress. It does not
predict inputs, restore game state, or perform rollback. The browser pipelines
inputs three ticks ahead; the server accepts a maximum 32-tick window.

## Run

Requires Go 1.25 or newer. Dependencies are pinned to `webtransport-go v0.12.0`
and `quic-go v0.61.0` in `go.mod` and verified through `go.sum`.

```sh
cd netplay/relay
go test -race ./...
go build -o /tmp/opensmash-relay .
RELAY_ADDR=:8443 \
RELAY_TLS_CERT=/path/to/fullchain.pem \
RELAY_TLS_KEY=/path/to/privkey.pem \
RELAY_ALLOWED_ORIGINS=https://game.example.com \
  /tmp/opensmash-relay
```

`RELAY_ALLOWED_ORIGINS` is a comma-separated list of exact website origins,
including any nondefault port, without trailing slashes. An Origin header from
this list is required for POST and WebTransport connections. GET replies include
CORS headers for these origins. No cookies or credentialed fetch are required.

For container deployment, run the build from this directory:

```sh
docker build -t opensmash-relay .
docker run --rm \
  -p 443:8443/tcp -p 443:8443/udp \
  -v /srv/relay-tls:/tls:ro \
  -e RELAY_TLS_CERT=/tls/fullchain.pem \
  -e RELAY_TLS_KEY=/tls/privkey.pem \
  -e RELAY_ALLOWED_ORIGINS=https://game.example.com \
  opensmash-relay
```

The certificate/key must be readable by container UID 65532. Use a publicly
trusted certificate for browser access. HTTPS and UDP port 443 must both reach
this process. An ordinary HTTP reverse proxy or the existing Cloud Run website
does not forward this WebTransport/UDP service; use a host or load balancer that
preserves its QUIC connections. Do not enable access logs containing the connect
query string: it contains the private player token. This service logs startup
and server failures without logging request URLs.

Point the website at the public origin, for example
`https://relay.example.com`, using its netplay relay configuration.
`GET /healthz` returns `{"ok":true,"protocol":1}` over HTTPS or HTTP/3.

Room state is held in one process. Run one relay instance for this version.
Restarting it ends its rooms; horizontal replicas require shared room ownership
and routing before they can safely serve the same invite links. The relay stores
no ROMs and needs no database or other outbound service.

## Protocol version 1

Room IDs are 16 cryptographically random bytes encoded as 32 lowercase hex
characters. An invite link contains only the room ID. The creator and each joined
player receive a separate random 32-byte base64url token. Treat that token as a
secret; it authorizes one seat and must never go in a shared game link.

### HTTPS room API

All POST bodies use `Content-Type: application/json`.

| Request | Result |
| --- | --- |
| `POST /v1/rooms` with `{engine:"ssb64"|"melee",config:{seed:123,...},name?:"Host"}` | HTTP 201 `{room,seat:0,token}` |
| `POST /v1/rooms/:id/join` with `{name?:"Guest"}` | HTTP 201 `{room,seat:1..3,token}` |
| `GET /v1/rooms/:id` | Public capability-based `room` snapshot, never player tokens |

`config` is an immutable JSON object of at most 64 KiB; `config.seed` must be an
unsigned 32-bit integer chosen before the engines are prepared. Config contains
match settings and content identifiers, never ROM bytes or private credentials.
The same seed/config are sent to all clients for preparing and starting.

Snapshots have this shape:

```json
{
  "id":"32-lowercase-hex-characters",
  "engine":"melee",
  "config":{"seed":123},
  "seed":123,
  "state":"lobby",
  "epoch":0,
  "players":[{"seat":0,"name":"Host","connected":true,"ready":false}],
  "expiresAt":"2026-09-15T12:00:00Z"
}
```

States are `lobby`, `preparing`, `running`, and `ended`. Seats reserve a place for
two minutes while the browser connects. Joining is permitted only in the lobby.
The host's departure closes the room. A lobby guest's departure releases its seat
and invalidates its token. Any departure after preparation ends the match; a new
game needs a new room. Reserved disconnected guests must connect or expire before
the host can prepare.

### WebTransport

Connect to `https://relay.example.com/v1/connect?room=ID&token=TOKEN`.
The client opens exactly one bidirectional stream and immediately writes a UTF-8
JSON line such as `{"type":"hello"}\n`; this makes the stream visible to QUIC.
Every message in both directions is a complete JSON object followed by newline.
Extra streams and application datagrams are rejected in this version.

| Client message | Meaning |
| --- | --- |
| `{type:"hello"}` | Initial message or heartbeat; send every 15 seconds while waiting |
| `{type:"prepare"}` | Host freezes connected seats, changes state to preparing |
| `{type:"ready",fingerprint:"..."}` | Engine is prepared; all players must report the same engine/content fingerprint |
| `{type:"start"}` | Host starts after every occupied seat is connected and ready; solo is allowed |
| `{type:"input",epoch:1,tick:0,pad:[buttons,x,y,cx,cy,l,r]}` | One pad for this connection's seat and exact tick |
| `{type:"leave"}` | Leave the room |

Fingerprints must match before starting, but are client assertions; this is not
an anti-cheat mechanism. The relay does not execute or verify game simulation.
The browser is responsible for fingerprinting the engine, ROM/content, and
frozen match settings, and for initializing deterministic engine state.

Pad values are integers: buttons `0..65535`, four stick axes `-128..127`, triggers
`0..255`. A client cannot provide or change its seat in a message. Inputs must
match the running epoch, cannot repeat a submitted tick, and must be between the
next unbroadcast tick and that tick plus 31. The first tick is zero.

Server messages:

```text
{type:"room",room:{...}}
{type:"prepare",players:[0,1],config:{...},seed:123}
{type:"start",epoch:1,seed:123,players:[0,1],config:{...}}
{type:"frame",epoch:1,tick:0,pads:[[...],[...],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]}
{type:"ended",reason:"Player 2 disconnected."}
{type:"error",code:"invalid_tick",message:"..."}
```

Frames are contiguous and released once every frozen seat supplies its input.
Absent seats receive all-zero pads. Prepare/start arrive before their matching
room snapshot. Clients should stop simulation on `ended`, transport closure, or
an invalid/out-of-order authoritative frame.

## Bounds and failure behavior

- Four players and 256 rooms maximum; five live rooms per source IP.
- 120 HTTPS/CONNECT requests per source IP per minute; the address table is
  bounded to 4,096 entries. Forwarded headers are not trusted.
- 4 KiB input lines, 240 messages/second/connection, and a 32-tick pending window.
- Outbound queues permit 64 messages and 512 KiB per player. Slow readers are
  disconnected rather than accumulating unbounded data.
- A client must open its control stream in 10 seconds. Read inactivity expires
  in 45 seconds; stream writes expire in five seconds.
- Running matches with no complete frame for 20 seconds end on the next sweep
  (every 15 seconds), even if clients keep sending heartbeats.
- Rooms expire after four hours or 30 idle minutes; ended snapshots persist for
  at most five minutes. Expiry is also checked during room API operations.

## Verification

`go test -race ./...` covers room/seat authorization, freeze/readiness, mismatched
fingerprints, same-seed startup, solo and multi-player frame barriers, malformed
and spoofed inputs, duplicates/out-of-window inputs, expiry, concurrent joins,
resource/backpressure limits, CORS, and token-safe snapshots. The integration test
uses actual local UDP sockets, TLS, HTTP/3 and WebTransport streams. It generates
a fresh certificate and trusts that certificate explicitly; TLS verification is
enabled. It exercises HTTPS room creation/join, QUIC authentication/origin checks,
a two-player match, matching frame delivery, and disconnect termination.

It does not substitute for browser/engine interoperability testing or testing
UDP reachability on the intended deployment network.

Upstream API references: [WebTransport server](https://quic-go.net/docs/webtransport/server/)
and the [pinned v0.12.0 example](https://github.com/quic-go/webtransport-go/tree/v0.12.0/example).
