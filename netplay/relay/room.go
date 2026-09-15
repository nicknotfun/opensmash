package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

const (
	maxPlayers              = 4
	maxRooms                = 256
	maxConfigBytes          = 64 * 1024
	maxWireBytes            = 128 * 1024
	maxSignalBytes          = 64 * 1024
	maxSDPBytes             = 48 * 1024
	maxSignalsPerMinute     = 240
	maxSignalBytesPerMinute = 2 * 1024 * 1024
	futureWindow            = 32
	maxTick                 = 60 * 60 * 4 * 60
)

type protocolError struct {
	Code, Message string
	Status        int
}

func (e *protocolError) Error() string            { return e.Message }
func fail(code, message string, status int) error { return &protocolError{code, message, status} }

type Pad [7]int

func validPad(p []int) bool {
	if len(p) != 7 || p[0] < 0 || p[0] > 65535 {
		return false
	}
	for _, v := range p[1:5] {
		if v < -128 || v > 127 {
			return false
		}
	}
	return p[5] >= 0 && p[5] <= 255 && p[6] >= 0 && p[6] <= 255
}

type playerView struct {
	Seat       int    `json:"seat"`
	Name       string `json:"name"`
	Connected  bool   `json:"connected"`
	Ready      bool   `json:"ready"`
	Generation uint32 `json:"generation"`
}
type roomView struct {
	ID        string          `json:"id"`
	Engine    string          `json:"engine"`
	Mode      string          `json:"mode"`
	Config    json.RawMessage `json:"config"`
	State     string          `json:"state"`
	Epoch     uint32          `json:"epoch"`
	Seed      uint32          `json:"seed"`
	Players   []playerView    `json:"players"`
	ExpiresAt time.Time       `json:"expiresAt"`
}
type reservation struct {
	Room  roomView `json:"room"`
	Seat  int      `json:"seat"`
	Token string   `json:"token"`
}
type player struct {
	token, name, fingerprint string
	reservedAt               time.Time
	connection               *peer
	ready                    bool
}
type pendingFrame struct {
	pads     [4]Pad
	received [4]bool
}
type room struct {
	id, engine, mode, address, state            string
	config                                      json.RawMessage
	createdAt, lastActive, expiresAt, lastFrame time.Time
	epoch, seed                                 uint32
	players                                     [4]*player
	playing                                     []int
	nextTick                                    int
	pending                                     map[int]*pendingFrame
	generations                                 [4]uint32
	negotiations                                [4]string
}
type peer struct {
	roomID                   string
	seat                     int
	out                      chan []byte
	done                     chan struct{}
	once                     sync.Once
	queued                   atomic.Int64
	signalWindow             time.Time
	signalCount, signalBytes int
}

func (p *peer) stop() { p.once.Do(func() { close(p.done) }) }

// Encode without HTML escaping so an accepted config cannot expand sixfold on
// the wire. The bound includes the newline and applies to every envelope.
func wireJSON(value any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(value); err != nil {
		return nil, err
	}
	if b.Len() > maxWireBytes {
		return nil, errors.New("protocol envelope is too large")
	}
	return b.Bytes(), nil
}
func (p *peer) send(value any) {
	data, err := wireJSON(value)
	if err != nil {
		p.stop()
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	if p.queued.Add(int64(len(data))) > 512*1024 {
		p.queued.Add(-int64(len(data)))
		p.stop()
		return
	}
	select {
	case p.out <- data:
	default:
		p.queued.Add(-int64(len(data)))
		p.stop()
	}
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*room
	now   func() time.Time
}

func newHub() *Hub { return &Hub{rooms: make(map[string]*room), now: time.Now} }
func secret(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func newPlayer(name string, now time.Time) (*player, error) {
	name = strings.TrimSpace(name)
	if len(name) > 40 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return nil, fail("invalid_name", "Name must be at most 40 bytes without control characters.", 400)
	}
	token, err := secret(32)
	if err != nil {
		return nil, err
	}
	return &player{token: token, name: name, reservedAt: now}, nil
}
func (r *room) view() roomView {
	v := roomView{ID: r.id, Engine: r.engine, Mode: r.mode, Config: append(json.RawMessage(nil), r.config...), State: r.state, Epoch: r.epoch, Seed: r.seed, ExpiresAt: r.expiresAt, Players: []playerView{}}
	for seat, p := range r.players {
		if p != nil {
			v.Players = append(v.Players, playerView{seat, p.name, p.connection != nil, p.ready, r.generations[seat]})
		}
	}
	return v
}
func (r *room) broadcast(value any) {
	for _, p := range r.players {
		if p != nil && p.connection != nil {
			p.connection.send(value)
		}
	}
}
func (r *room) broadcastRoom() { r.broadcast(map[string]any{"type": "room", "room": r.view()}) }
func (r *room) end(reason string, now time.Time) {
	if r.state == "ended" {
		return
	}
	r.state = "ended"
	r.pending = nil
	r.expiresAt = now.Add(5 * time.Minute)
	r.broadcast(map[string]any{"type": "ended", "reason": reason})
	r.broadcastRoom()
}
func (h *Hub) sweepLocked() {
	now := h.now()
	for id, r := range h.rooms {
		if r.mode == "lockstep" && r.state == "running" && now.Sub(r.lastFrame) > 20*time.Second {
			r.end("No complete input frame arrived for 20 seconds.", now)
		}
		if now.After(r.expiresAt) || now.Sub(r.lastActive) > 30*time.Minute {
			r.end("Room expired.", now)
			for _, p := range r.players {
				if p != nil && p.connection != nil {
					p.connection.stop()
				}
			}
			delete(h.rooms, id)
			continue
		}
		if r.state != "lobby" && (r.mode != "host-stream" || r.state == "ended") {
			continue
		}
		changed := false
		for seat, p := range r.players {
			if p != nil && p.connection == nil && now.Sub(p.reservedAt) > 2*time.Minute {
				if seat == 0 {
					r.end("Host did not connect.", now)
				} else {
					r.players[seat] = nil
					changed = true
				}
			}
		}
		if changed {
			r.broadcastRoom()
		}
	}
}
func (h *Hub) Sweep() { h.mu.Lock(); defer h.mu.Unlock(); h.sweepLocked() }
func (h *Hub) Create(engine string, config json.RawMessage, name, address string) (reservation, error) {
	return h.CreateMode(engine, "lockstep", config, name, address)
}
func (h *Hub) CreateMode(engine, mode string, config json.RawMessage, name, address string) (reservation, error) {
	if mode == "" {
		mode = "lockstep"
	}
	if mode != "lockstep" && mode != "host-stream" || mode == "host-stream" && engine != "melee" {
		return reservation{}, fail("invalid_mode", "Choose lockstep, or host-stream for Melee.", 400)
	}
	if engine != "ssb64" && engine != "melee" {
		return reservation{}, fail("invalid_engine", "Choose ssb64 or melee.", 400)
	}
	if len(config) == 0 {
		config = json.RawMessage(`{}`)
	}
	if len(config) > maxConfigBytes || !json.Valid(config) || len(strings.TrimSpace(string(config))) == 0 || strings.TrimSpace(string(config))[0] != '{' {
		return reservation{}, fail("invalid_config", "Config must be a JSON object up to 64 KiB.", 400)
	}
	if data, err := wireJSON(config); err != nil || len(data) > maxWireBytes-4096 {
		return reservation{}, fail("invalid_config", "Serialized config leaves insufficient room for protocol metadata.", 400)
	}
	var metadata struct {
		Seed *uint32 `json:"seed"`
	}
	if err := json.Unmarshal(config, &metadata); err != nil || metadata.Seed == nil {
		return reservation{}, fail("invalid_seed", "config.seed must be an unsigned 32-bit integer.", 400)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	if len(h.rooms) >= maxRooms {
		// Ended snapshots are useful for old invitations, but their retention
		// must not let create/connect/leave churn displace live games. Reclaim
		// the oldest tombstone only when admission needs its slot.
		var oldest *room
		for _, candidate := range h.rooms {
			if candidate.state == "ended" && (oldest == nil || candidate.expiresAt.Before(oldest.expiresAt)) {
				oldest = candidate
			}
		}
		if oldest != nil {
			for _, player := range oldest.players {
				if player != nil && player.connection != nil {
					player.connection.stop()
				}
			}
			delete(h.rooms, oldest.id)
		} else {
			return reservation{}, fail("capacity", "Room capacity reached.", 503)
		}
	}
	count := 0
	for _, r := range h.rooms {
		if r.address == address && r.state != "ended" {
			count++
		}
	}
	if count >= 5 {
		return reservation{}, fail("rate_limit", "Too many rooms from this address.", 429)
	}
	p, err := newPlayer(name, h.now())
	if err != nil {
		return reservation{}, err
	}
	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return reservation{}, err
	}
	id := hex.EncodeToString(idBytes[:])
	now := h.now()
	r := &room{id: id, engine: engine, mode: mode, config: append(json.RawMessage(nil), config...), seed: *metadata.Seed, address: address, state: "lobby", createdAt: now, lastActive: now, expiresAt: now.Add(4 * time.Hour)}
	r.players[0] = p
	h.rooms[id] = r
	return reservation{r.view(), 0, p.token}, nil
}
func (h *Hub) lookup(id string) (*room, error) {
	r := h.rooms[id]
	if r == nil {
		return nil, fail("not_found", "Room has expired or does not exist.", 404)
	}
	return r, nil
}
func (h *Hub) Snapshot(id string) (roomView, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	r, err := h.lookup(id)
	if err != nil {
		return roomView{}, err
	}
	return r.view(), nil
}
func (h *Hub) Join(id, name string) (reservation, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	r, err := h.lookup(id)
	if err != nil {
		return reservation{}, err
	}
	if !r.joinable() {
		return reservation{}, fail("not_joinable", "This room is no longer accepting players.", 409)
	}
	for seat := 1; seat < 4; seat++ {
		if r.players[seat] == nil {
			p, err := newPlayer(name, h.now())
			if err != nil {
				return reservation{}, err
			}
			r.players[seat] = p
			r.lastActive = h.now()
			r.broadcastRoom()
			return reservation{r.view(), seat, p.token}, nil
		}
	}
	return reservation{}, fail("full", "This room already has four players.", 409)
}

func (r *room) joinable() bool {
	return r.state == "lobby" || r.mode == "host-stream" && (r.state == "preparing" || r.state == "running")
}

type streamAuthorization struct {
	Seat       int    `json:"seat"`
	Mode       string `json:"mode"`
	Connected  bool   `json:"connected"`
	Generation uint32 `json:"generation"`
}

// AuthorizeStream lets the website issue short-lived TURN credentials only to
// an authenticated, connected participant. It never returns seat capabilities.
func (h *Hub) AuthorizeStream(id, token string) (streamAuthorization, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	r, err := h.lookup(id)
	if err != nil {
		return streamAuthorization{}, err
	}
	if r.mode == "host-stream" && r.state != "ended" {
		for seat, p := range r.players {
			if p != nil && p.connection != nil && subtle.ConstantTimeCompare([]byte(p.token), []byte(token)) == 1 {
				select {
				case <-p.connection.done:
					continue
				default:
				}
				return streamAuthorization{seat, r.mode, true, r.generations[seat]}, nil
			}
		}
	}
	return streamAuthorization{}, fail("unauthorized", "A connected host-stream player token is required.", 403)
}

// Reserve the connection before upgrading so duplicate token connections cannot race.
func (h *Hub) Attach(id, token string) (*peer, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	r, err := h.lookup(id)
	if err != nil {
		return nil, err
	}
	if !r.joinable() {
		return nil, fail("not_joinable", "This room is no longer accepting connections.", 409)
	}
	for seat, p := range r.players {
		if p != nil && subtle.ConstantTimeCompare([]byte(p.token), []byte(token)) == 1 {
			if p.connection != nil {
				return nil, fail("already_connected", "This seat is already connected.", 409)
			}
			c := &peer{roomID: id, seat: seat, out: make(chan []byte, 64), done: make(chan struct{})}
			p.connection = c
			r.generations[seat]++
			r.negotiations[seat] = ""
			r.lastActive = h.now()
			r.broadcastRoom()
			return c, nil
		}
	}
	return nil, fail("unauthorized", "Invalid player token.", 403)
}
func (h *Hub) Detach(c *peer) {
	c.stop()
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.roomID]
	if r == nil {
		return
	}
	p := r.players[c.seat]
	if p == nil || p.connection != c {
		return
	}
	p.connection = nil
	p.fingerprint = ""
	p.ready = false
	r.negotiations[c.seat] = ""
	if c.seat == 0 {
		r.end("Host left the room.", h.now())
	} else {
		if r.mode == "lockstep" && (r.state == "running" || r.state == "preparing") {
			r.end(fmt.Sprintf("Player %d disconnected.", c.seat+1), h.now())
		}
		r.players[c.seat] = nil
	}
	r.broadcastRoom()
}

type clientMessage struct {
	Type        string         `json:"type"`
	Fingerprint string         `json:"fingerprint,omitempty"`
	Epoch       uint32         `json:"epoch,omitempty"`
	Tick        int            `json:"tick,omitempty"`
	Pad         []int          `json:"pad,omitempty"`
	To          *int           `json:"to,omitempty"`
	Generation  uint32         `json:"generation,omitempty"`
	Signal      *signalMessage `json:"signal,omitempty"`
}

func (h *Hub) Message(c *peer, m clientMessage) error {
	if m.Type == "leave" {
		h.Detach(c)
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, err := h.lookup(c.roomID)
	if err != nil {
		return err
	}
	p := r.players[c.seat]
	if p == nil || p.connection != c {
		return fail("unauthorized", "Seat is no longer connected.", 403)
	}
	select {
	case <-c.done:
		return errors.New("connection closed")
	default:
	}
	r.lastActive = h.now()
	switch m.Type {
	case "hello":
		return nil
	case "signal":
		return r.signal(c, m, h.now())
	case "prepare":
		if c.seat != 0 {
			return fail("host_only", "Only the host can prepare the game.", 403)
		}
		if r.state != "lobby" {
			return fail("not_lobby", "This room has already been prepared.", 409)
		}
		seats := []int{}
		for seat, other := range r.players {
			if other != nil {
				if other.connection == nil && r.mode == "lockstep" {
					return fail("not_connected", "Every reserved player must connect before preparing.", 409)
				}
				if other.connection != nil {
					seats = append(seats, seat)
				}
			}
		}
		r.playing = seats
		r.state = "preparing"
		r.broadcast(map[string]any{"type": "prepare", "players": seats, "config": json.RawMessage(r.config), "seed": r.seed})
		r.broadcastRoom()
		return nil
	case "ready":
		if r.state != "preparing" {
			return fail("not_preparing", "The host must prepare the game before players become ready.", 409)
		}
		if r.mode == "host-stream" {
			if c.seat != 0 {
				return fail("host_only", "Only the host prepares the streaming engine.", 403)
			}
			if p.ready {
				return nil
			}
			p.ready = true
			r.broadcastRoom()
			return nil
		}
		if len(m.Fingerprint) < 1 || len(m.Fingerprint) > 256 || strings.IndexFunc(m.Fingerprint, unicode.IsControl) >= 0 {
			return fail("invalid_fingerprint", "Provide a content fingerprint up to 256 bytes.", 400)
		}
		for _, other := range r.players {
			if other != nil && other != p && other.fingerprint != "" && other.fingerprint != m.Fingerprint {
				return fail("incompatible", "Players must use identical engine builds and game content.", 409)
			}
		}
		if p.fingerprint == m.Fingerprint {
			return nil
		}
		p.fingerprint = m.Fingerprint
		p.ready = true
		r.broadcastRoom()
		return nil
	case "start":
		if c.seat != 0 {
			return fail("host_only", "Only the host can start.", 403)
		}
		if r.state != "preparing" {
			return fail("not_preparing", "The host must prepare the game before starting.", 409)
		}
		seats := []int{}
		for seat, other := range r.players {
			if other != nil {
				if (r.mode == "lockstep" || seat == 0) && (other.connection == nil || !other.ready) {
					return fail("not_ready", "Every player must connect and be ready.", 409)
				}
				if other.connection != nil {
					seats = append(seats, seat)
				}
			}
		}
		r.epoch++
		r.state = "running"
		r.playing = seats
		r.nextTick = 0
		r.lastFrame = h.now()
		if r.mode == "lockstep" {
			r.pending = make(map[int]*pendingFrame)
		}
		r.broadcast(map[string]any{"type": "start", "epoch": r.epoch, "seed": r.seed, "players": seats, "config": json.RawMessage(r.config)})
		r.broadcastRoom()
		return nil
	case "input":
		if r.mode != "lockstep" {
			return fail("wrong_mode", "Host-stream controller input travels over WebRTC.", 409)
		}
		if r.state != "running" || m.Epoch != r.epoch {
			return fail("wrong_epoch", "Input does not belong to this running match.", 409)
		}
		if m.Tick < r.nextTick || m.Tick >= r.nextTick+futureWindow || m.Tick >= maxTick {
			return fail("invalid_tick", "Input tick is stale or outside the 32-frame window.", 400)
		}
		if !validPad(m.Pad) {
			return fail("invalid_pad", "Expected seven bounded controller integers.", 400)
		}
		f := r.pending[m.Tick]
		if f == nil {
			f = &pendingFrame{}
			r.pending[m.Tick] = f
		}
		if f.received[c.seat] {
			return fail("duplicate_input", "Each seat may submit a tick only once.", 409)
		}
		copy(f.pads[c.seat][:], m.Pad)
		f.received[c.seat] = true
		for {
			f = r.pending[r.nextTick]
			if f == nil {
				break
			}
			complete := true
			for _, seat := range r.playing {
				if !f.received[seat] {
					complete = false
				}
			}
			if !complete {
				break
			}
			r.broadcast(map[string]any{"type": "frame", "epoch": r.epoch, "tick": r.nextTick, "pads": f.pads})
			delete(r.pending, r.nextTick)
			r.nextTick++
			r.lastFrame = h.now()
		}
		return nil
	default:
		return fail("unknown_message", "Unknown message type.", 400)
	}
}
