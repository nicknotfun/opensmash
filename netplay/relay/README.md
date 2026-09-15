# OpenSmash WebTransport relay

This Go service coordinates rooms and exchanges controller input over an ordered
WebTransport stream (HTTP/3 over QUIC). It also serves its room API over ordinary
HTTPS on the same port. Browser clients contact this relay directly; the Node
website supplies its public HTTPS origin through the netplay configuration.

Rooms have two explicit modes. The default, `lockstep`, runs a game engine in
all players' browsers. Melee can instead use `host-stream`: only the host runs
the engine; the relay exchanges targeted WebRTC offers, answers, and ICE
candidates. Guests receive the host's video/audio and return controller input
over WebRTC. The relay never receives the ISO, game files, or media streams.

In lockstep mode, the relay starts each simulation tick only after receiving that tick from every
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
| `POST /v1/rooms` with `{engine:"ssb64"|"melee",mode?:"lockstep"|"host-stream",config:{seed:123,...},name?:"Host"}` | HTTP 201 `{room,seat:0,token}` |
| `POST /v1/rooms/:id/join` with `{name?:"Guest"}` | HTTP 201 `{room,seat:1..3,token}` |
| `GET /v1/rooms/:id` | Public capability-based `room` snapshot, never player tokens |
| `POST /v1/rooms/:id/authorize` with `{token:"private-seat-capability"}` | HTTP 200 `{seat,mode:"host-stream",connected:true,generation}` only for a connected, live streaming player |

`mode` defaults to `lockstep`; `host-stream` is accepted only with `engine:"melee"`.
The authorize endpoint lets the website verify a player's capability before
issuing short-lived TURN credentials. The website must send its configured,
allowed `Origin` header. The capability goes in the POST body, never the URL,
and is never returned. Authorization fails after disconnection or room end.

`config` is an immutable JSON object of at most 64 KiB; `config.seed` must be an
unsigned 32-bit integer chosen before the engines are prepared. Config contains
match settings and content identifiers, never ROM bytes or private credentials.
The same seed/config are sent to all clients for preparing and starting.

Snapshots have this shape:

```json
{
  "id":"32-lowercase-hex-characters",
  "engine":"melee",
  "mode":"lockstep",
  "config":{"seed":123},
  "seed":123,
  "state":"lobby",
  "epoch":0,
  "players":[{"seat":0,"name":"Host","connected":true,"ready":false,"generation":1}],
  "expiresAt":"2026-09-15T12:00:00Z"
}
```

States are `lobby`, `preparing`, `running`, and `ended`. Seats reserve a place for
two minutes while the browser connects. Each seat's `generation` increments
when its connection attaches; it is not reused when a guest leaves and another
guest takes that seat. A never-connected seat has generation zero.

In lockstep mode, joining is permitted only in the lobby.
The host's departure closes the room. A lobby guest's departure releases its seat
and invalidates its token. Any departure after preparation ends the match; a new
game needs a new room. Reserved disconnected guests must connect or expire before
the host can prepare.

In host-stream mode, guests can join the lobby, preparing game, or running game.
Only the host prepares the engine and sends `ready` (without a fingerprint), then
`start`. A solo host can start, and pending guest reservations do not block it.
Guests never initialize an engine or assert a content fingerprint. A guest's
departure releases its seat and token; the game keeps running. Browsers must
close that guest's WebRTC connection and neutralize its controller immediately.
The host's departure still ends the room. Browser adapters must handle a late
guest using the room's running state and epoch, since that guest did not receive
the original `start` event.

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
| `{type:"signal",to:1,generation:1,signal:{...}}` | Targeted host-stream WebRTC negotiation; see below |

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

### Host-stream negotiation

The host is always seat zero and initiates each guest connection with an offer.
A guest can answer or send ICE to seat zero; it cannot signal another guest.
Signaling is permitted in any non-ended host-stream room. The relay does not
accept lockstep `input` messages in this mode.

```text
// Host to guest. generation is the recipient's current room generation.
{type:"signal",to:1,generation:2,signal:{id:"0123456789abcdef0123456789abcdef",description:{type:"offer",sdp:"..."}}}
// Guest to host (the guest copies the host-generated negotiation id).
{type:"signal",to:0,generation:1,signal:{id:"0123456789abcdef0123456789abcdef",description:{type:"answer",sdp:"..."}}}
// Either direction; candidate:null is the end-of-candidates marker.
{type:"signal",to:0,generation:1,signal:{id:"0123456789abcdef0123456789abcdef",candidate:{candidate:"...",sdpMid:"0",sdpMLineIndex:0,usernameFragment:"..."}}}
// Relay to the one intended recipient. from is derived from authentication.
{type:"signal",from:1,generation:2,toGeneration:1,signal:{...}}
```

The inner object contains a cryptographically random, host-generated 16-byte
lowercase hex `id` and exactly one of `description` or `candidate`. SDP is at
most 48 KiB. Candidate strings are at most 4 KiB, candidate objects at most
8 KiB, and optional `sdpMid`/`usernameFragment` strings at most 256 bytes.
Only `offer` from the host and `answer` from a guest are allowed.

The relay records the latest accepted host offer id for each guest. Answers and
ICE for previous negotiations are rejected. Disconnecting a guest clears that
id; replacing the connection also changes its generation. Clients must check
both the forwarded sender `generation` and recipient `toGeneration` against
their room snapshot, and ignore stale negotiation ids. Room snapshots and
signals share the same ordered control stream, so generation updates precede
signals for a new connection. The relay never broadcasts SDP or ICE to other
players or exposes them in public room snapshots.

WebRTC media and the controller data channel flow directly between browsers,
or through a separately configured TURN service when a direct connection is
unavailable. This service provides signaling only; it cannot forward media or
act as TURN. Streaming has no server frame barrier or frame-stall timeout.
The host browser owns simulation scheduling independently of media capture.

## Bounds and failure behavior

- Four players and 256 rooms maximum; five live rooms per source IP.
- 120 HTTPS/CONNECT requests per source IP per minute; the address table is
  bounded to 4,096 entries. Forwarded headers are not trusted.
- Non-signaling messages are smaller than 4 KiB. Signaling lines/envelopes are
  limited to 64 KiB, with at most 240 accepted signals and 2 MiB per connection
  per minute. All messages share a 240-messages/second/connection limit.
- Every outbound JSON envelope, including its newline, is at most 128 KiB.
  Config is encoded without unnecessary HTML escaping and checked for adequate
  room metadata space before admission. Lockstep has a 32-tick pending window.
- Outbound queues permit 64 messages and 512 KiB per player. Slow readers are
  disconnected rather than accumulating unbounded data.
- A client must open its control stream in 10 seconds. Read inactivity expires
  in 45 seconds; stream writes expire in five seconds.
- Running lockstep matches with no complete frame for 20 seconds end on the next sweep
  (every 15 seconds), even if clients keep sending heartbeats.
- Rooms expire after four hours or 30 idle minutes; ended snapshots persist for
  at most five minutes. The oldest ended snapshot is reclaimed earlier when
  needed to admit a new room at capacity; active rooms are never evicted.
  Expiry is also checked during room API operations.

## Verification

`go test -race ./...` covers room/seat authorization, freeze/readiness, mismatched
fingerprints, same-seed startup, solo and multi-player frame barriers, malformed
and spoofed inputs, duplicates/out-of-window inputs, expiry, concurrent joins,
resource/backpressure limits, CORS, and token-safe snapshots. The integration test
uses actual local UDP sockets, TLS, HTTP/3 and WebTransport streams. It generates
a fresh certificate and trusts that certificate explicitly; TLS verification is
enabled. It exercises HTTPS room creation/join, QUIC authentication/origin checks,
a two-player match, matching frame delivery, and disconnect termination. It also
exercises host-stream signaling with a 16 KiB SDP, host-only startup, live guest
replacement, generation fencing, and host-disconnect termination. Unit tests
cover private targeted routing, signaling nonce replay, malformed/oversized
SDP and ICE, signaling rate and byte limits, and connected-seat authorization
for TURN credentials. Existing lockstep behavior remains covered.

It does not substitute for browser/engine interoperability testing or testing
UDP reachability on the intended deployment network.

Upstream API references: [WebTransport server](https://quic-go.net/docs/webtransport/server/)
and the [pinned v0.12.0 example](https://github.com/quic-go/webtransport-go/tree/v0.12.0/example).
