package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustRoom(t *testing.T, h *Hub) reservation {
	t.Helper()
	r, err := h.Create("melee", json.RawMessage(`{"seed":12345}`), "host", "test")
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func mustAttach(t *testing.T, h *Hub, r reservation) *peer {
	t.Helper()
	p, err := h.Attach(r.Room.ID, r.Token)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func mustMessage(t *testing.T, h *Hub, p *peer, m clientMessage) {
	t.Helper()
	if err := h.Message(p, m); err != nil {
		t.Fatal(err)
	}
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *protocolError
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func drain(p *peer) []map[string]any {
	out := []map[string]any{}
	for {
		select {
		case b := <-p.out:
			p.queued.Add(-int64(len(b)))
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			out = append(out, m)
		default:
			return out
		}
	}
}
func startRoom(t *testing.T, count int) (*Hub, reservation, []*peer) {
	t.Helper()
	h := newHub()
	r := mustRoom(t, h)
	peers := []*peer{mustAttach(t, h, r)}
	for i := 1; i < count; i++ {
		guest, err := h.Join(r.Room.ID, "guest")
		if err != nil {
			t.Fatal(err)
		}
		peers = append(peers, mustAttach(t, h, guest))
	}
	mustMessage(t, h, peers[0], clientMessage{Type: "prepare"})
	for _, p := range peers {
		mustMessage(t, h, p, clientMessage{Type: "ready", Fingerprint: "same-build-and-content"})
	}
	mustMessage(t, h, peers[0], clientMessage{Type: "start"})
	for _, p := range peers {
		drain(p)
	}
	return h, r, peers
}

func TestRosterFreezeReadinessAndCapabilities(t *testing.T) {
	h := newHub()
	host := mustRoom(t, h)
	if len(host.Room.ID) != 32 || len(host.Token) != 43 {
		t.Fatal("unexpected capability sizes")
	}
	if host.Room.Seed != 12345 {
		t.Fatal("seed changed")
	}
	p := mustAttach(t, h, host)
	_, err := h.Attach(host.Room.ID, host.Token)
	expectCode(t, err, "already_connected")
	_, err = h.Attach(host.Room.ID, strings.Repeat("x", 43))
	expectCode(t, err, "unauthorized")
	guest, err := h.Join(host.Room.ID, "guest")
	if err != nil {
		t.Fatal(err)
	}
	expectCode(t, h.Message(p, clientMessage{Type: "prepare"}), "not_connected")
	g := mustAttach(t, h, guest)
	expectCode(t, h.Message(g, clientMessage{Type: "prepare"}), "host_only")
	expectCode(t, h.Message(p, clientMessage{Type: "ready", Fingerprint: "v1"}), "not_preparing")
	mustMessage(t, h, p, clientMessage{Type: "prepare"})
	_, err = h.Join(host.Room.ID, "late")
	expectCode(t, err, "not_joinable")
	mustMessage(t, h, p, clientMessage{Type: "ready", Fingerprint: "v1"})
	expectCode(t, h.Message(g, clientMessage{Type: "ready", Fingerprint: "v2"}), "incompatible")
	expectCode(t, h.Message(p, clientMessage{Type: "start"}), "not_ready")
	mustMessage(t, h, g, clientMessage{Type: "ready", Fingerprint: "v1"})
	expectCode(t, h.Message(g, clientMessage{Type: "start"}), "host_only")
	mustMessage(t, h, p, clientMessage{Type: "start"})
	v, _ := h.Snapshot(host.Room.ID)
	if v.State != "running" || v.Epoch != 1 || v.Seed != 12345 {
		t.Fatalf("unexpected snapshot: %+v", v)
	}
	bytes, _ := json.Marshal(v)
	if strings.Contains(string(bytes), host.Token) || strings.Contains(string(bytes), guest.Token) {
		t.Fatal("snapshot leaked a token")
	}
}
func TestFramesWaitForEverySeatAndEmitContiguously(t *testing.T) {
	h, _, p := startRoom(t, 2)
	input := func(seat, tick, buttons int) clientMessage {
		return clientMessage{Type: "input", Epoch: 1, Tick: tick, Pad: []int{buttons, seat, 0, 0, 0, 0, 0}}
	}
	mustMessage(t, h, p[0], input(0, 1, 11))
	mustMessage(t, h, p[1], input(1, 1, 22))
	if len(drain(p[0])) != 0 {
		t.Fatal("frame1 overtook frame0")
	}
	mustMessage(t, h, p[0], input(0, 0, 3))
	if len(drain(p[0])) != 0 {
		t.Fatal("frame emitted before every seat submitted")
	}
	mustMessage(t, h, p[1], input(1, 0, 4))
	for _, peer := range p {
		events := drain(peer)
		if len(events) != 2 {
			t.Fatalf("want two frames: %v", events)
		}
		for tick, event := range events {
			if event["type"] != "frame" || event["tick"] != float64(tick) {
				t.Fatalf("bad order: %v", events)
			}
			pads := event["pads"].([]any)
			if len(pads) != 4 || pads[2].([]any)[0] != float64(0) {
				t.Fatal("absent ports must be neutral")
			}
		}
	}
	expectCode(t, h.Message(p[0], input(0, 0, 99)), "invalid_tick")
}
func TestAdversarialInputBoundsAndDuplicate(t *testing.T) {
	h, _, p := startRoom(t, 2)
	for _, tc := range []struct {
		name, code string
		msg        clientMessage
	}{
		{"epoch", "wrong_epoch", clientMessage{Type: "input", Epoch: 2, Tick: 0, Pad: []int{0, 0, 0, 0, 0, 0, 0}}},
		{"negative tick", "invalid_tick", clientMessage{Type: "input", Epoch: 1, Tick: -1, Pad: []int{0, 0, 0, 0, 0, 0, 0}}},
		{"future tick", "invalid_tick", clientMessage{Type: "input", Epoch: 1, Tick: 32, Pad: []int{0, 0, 0, 0, 0, 0, 0}}},
		{"buttons", "invalid_pad", clientMessage{Type: "input", Epoch: 1, Pad: []int{65536, 0, 0, 0, 0, 0, 0}}},
		{"stick", "invalid_pad", clientMessage{Type: "input", Epoch: 1, Pad: []int{0, -129, 0, 0, 0, 0, 0}}},
		{"trigger", "invalid_pad", clientMessage{Type: "input", Epoch: 1, Pad: []int{0, 0, 0, 0, 0, 256, 0}}},
		{"pad length", "invalid_pad", clientMessage{Type: "input", Epoch: 1, Pad: []int{0}}},
	} {
		t.Run(tc.name, func(t *testing.T) { expectCode(t, h.Message(p[0], tc.msg), tc.code) })
	}
	m := clientMessage{Type: "input", Epoch: 1, Tick: 0, Pad: []int{65535, -128, 127, 0, 0, 255, 255}}
	mustMessage(t, h, p[0], m)
	expectCode(t, h.Message(p[0], m), "duplicate_input")
	for _, raw := range []string{`{"type":"input","seat":1}`, `{"type":"input","pad":[1.5,0,0,0,0,0,0]}`, `{"type":"start"} {"type":"leave"}`} {
		if strictJSON([]byte(raw), new(clientMessage)) == nil {
			t.Fatalf("accepted malformed/spoofed input %s", raw)
		}
	}
}
func TestDisconnectCannotChangeFrozenRoster(t *testing.T) {
	for _, phase := range []string{"lobby", "preparing", "running"} {
		t.Run(phase, func(t *testing.T) {
			h := newHub()
			host := mustRoom(t, h)
			p := mustAttach(t, h, host)
			guest, _ := h.Join(host.Room.ID, "guest")
			g := mustAttach(t, h, guest)
			if phase != "lobby" {
				mustMessage(t, h, p, clientMessage{Type: "prepare"})
			}
			if phase == "running" {
				for _, peer := range []*peer{p, g} {
					mustMessage(t, h, peer, clientMessage{Type: "ready", Fingerprint: "v1"})
				}
				mustMessage(t, h, p, clientMessage{Type: "start"})
			}
			h.Detach(g)
			v, _ := h.Snapshot(host.Room.ID)
			if phase == "lobby" {
				if v.State != "lobby" {
					t.Fatal(v.State)
				}
				next, err := h.Join(host.Room.ID, "new")
				if err != nil || next.Seat != guest.Seat || next.Token == guest.Token {
					t.Fatal("seat did not safely reclaim")
				}
				_, err = h.Attach(host.Room.ID, guest.Token)
				expectCode(t, err, "unauthorized")
			} else {
				if v.State != "ended" {
					t.Fatalf("frozen match survived disconnect: %s", v.State)
				}
			}
		})
	}
}
func TestSoloRoomAndHostDeparture(t *testing.T) {
	h, r, p := startRoom(t, 1)
	mustMessage(t, h, p[0], clientMessage{Type: "input", Epoch: 1, Pad: []int{1, 0, 0, 0, 0, 0, 0}})
	if len(drain(p[0])) != 1 {
		t.Fatal("solo did not advance")
	}
	h.Detach(p[0])
	v, _ := h.Snapshot(r.Room.ID)
	if v.State != "ended" {
		t.Fatal("host departure did not close room")
	}
}
func TestExpiryReservationsAndInputStall(t *testing.T) {
	now := time.Now()
	h := newHub()
	h.now = func() time.Time { return now }
	r := mustRoom(t, h)
	host := mustAttach(t, h, r)
	guest, _ := h.Join(r.Room.ID, "abandoned")
	now = now.Add(121 * time.Second)
	h.Sweep()
	next, err := h.Join(r.Room.ID, "replacement")
	if err != nil || next.Seat != guest.Seat {
		t.Fatal("reservation did not expire")
	}
	h.Detach(host)
	now = now.Add(6 * time.Minute)
	h.Sweep()
	_, err = h.Snapshot(r.Room.ID)
	expectCode(t, err, "not_found")
	h, r, _ = startRoom(t, 1)
	future := time.Now().Add(21 * time.Second)
	h.now = func() time.Time { return future }
	h.Sweep()
	v, _ := h.Snapshot(r.Room.ID)
	if v.State != "ended" {
		t.Fatal("stalled match not ended")
	}
}
func TestConcurrentJoinCapacity(t *testing.T) {
	h := newHub()
	host := mustRoom(t, h)
	var wg sync.WaitGroup
	var mu sync.Mutex
	seats := map[int]bool{}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := h.Join(host.Room.ID, "guest")
			if err == nil {
				mu.Lock()
				if seats[r.Seat] {
					t.Error("duplicate seat")
				}
				seats[r.Seat] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(seats) != 3 {
		t.Fatalf("admitted %d guests", len(seats))
	}
}
func TestResourceBounds(t *testing.T) {
	h := newHub()
	for i := 0; i < 5; i++ {
		mustRoom(t, h)
	}
	_, err := h.Create("melee", json.RawMessage(`{"seed":1}`), "", "test")
	expectCode(t, err, "rate_limit")
	for i := 5; i < maxRooms; i++ {
		_, err := h.Create("ssb64", json.RawMessage(`{"seed":1}`), "", fmt.Sprint(i))
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = h.Create("melee", json.RawMessage(`{"seed":1}`), "", "fresh")
	expectCode(t, err, "capacity")
	p := &peer{out: make(chan []byte, 64), done: make(chan struct{})}
	for i := 0; i < 65; i++ {
		p.send(map[string]any{"type": "frame"})
	}
	select {
	case <-p.done:
	default:
		t.Fatal("slow consumer was not terminated")
	}
	p = &peer{out: make(chan []byte, 64), done: make(chan struct{})}
	for i := 0; i < 10; i++ {
		p.send(strings.Repeat("x", 65536))
	}
	select {
	case <-p.done:
	default:
		t.Fatal("byte queue bound not enforced")
	}
}
func TestInvalidConfigAndSeed(t *testing.T) {
	for _, config := range []string{`{}`, `null`, `[]`, `{"seed":-1}`, `{"seed":4294967296}`, `{"seed":1.5}`, `{"seed":"1"}`, `{"seed":1,"large":"` + strings.Repeat("x", maxConfigBytes) + `"}`} {
		_, err := newHub().Create("melee", json.RawMessage(config), "", "test")
		if err == nil {
			t.Fatalf("accepted invalid config %s", config[:min(len(config), 30)])
		}
	}
}
