package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func streamRoom(t *testing.T, guests int) (*Hub, reservation, []*peer) {
	t.Helper()
	h := newHub()
	r, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":7}`), "host", "test")
	if err != nil {
		t.Fatal(err)
	}
	peers := []*peer{mustAttach(t, h, r)}
	for i := 0; i < guests; i++ {
		g, err := h.Join(r.Room.ID, "guest")
		if err != nil {
			t.Fatal(err)
		}
		peers = append(peers, mustAttach(t, h, g))
	}
	for _, p := range peers {
		drain(p)
	}
	return h, r, peers
}

func offer(to int, generation uint32, id string) clientMessage {
	return clientMessage{Type: "signal", To: &to, Generation: generation, Signal: &signalMessage{ID: id, Description: &signalDescription{Type: "offer", SDP: "v=0\r\n"}}}
}

func answer(generation uint32, id string) clientMessage {
	m := offer(0, generation, id)
	m.Signal.Description.Type = "answer"
	return m
}

func candidate(to int, generation uint32, id string) clientMessage {
	return clientMessage{Type: "signal", To: &to, Generation: generation, Signal: &signalMessage{ID: id, Candidate: json.RawMessage(`{"candidate":"candidate:1 1 udp 1 192.0.2.1 5000 typ host","sdpMid":"0","sdpMLineIndex":0}`)}}
}

const negotiationID = "0123456789abcdef0123456789abcdef"

func TestRoomModesAndStreamLifecycle(t *testing.T) {
	for _, tc := range []struct{ engine, mode string }{{"ssb64", "host-stream"}, {"melee", "unknown"}, {"melee", "HOST-STREAM"}} {
		_, err := newHub().CreateMode(tc.engine, tc.mode, json.RawMessage(`{"seed":7}`), "", "test")
		expectCode(t, err, "invalid_mode")
	}
	legacy, err := newHub().CreateMode("melee", "", json.RawMessage(`{"seed":7}`), "", "test")
	if err != nil || legacy.Room.Mode != "lockstep" {
		t.Fatal("omitted mode must remain lockstep")
	}
	h, r, peers := streamRoom(t, 1)
	host, guest := peers[0], peers[1]
	if r.Room.Mode != "host-stream" {
		t.Fatal("stream mode not exposed")
	}
	mustMessage(t, h, host, clientMessage{Type: "prepare"})
	expectCode(t, h.Message(guest, clientMessage{Type: "ready", Fingerprint: "fake"}), "host_only")
	expectCode(t, h.Message(host, clientMessage{Type: "start"}), "not_ready")
	mustMessage(t, h, host, clientMessage{Type: "ready"})
	mustMessage(t, h, host, clientMessage{Type: "start"})
	v, _ := h.Snapshot(r.Room.ID)
	if v.State != "running" || !v.Players[0].Ready || v.Players[1].Ready {
		t.Fatalf("host readiness did not start: %+v", v)
	}
	expectCode(t, h.Message(host, clientMessage{Type: "input", Epoch: 1, Pad: []int{0, 0, 0, 0, 0, 0, 0}}), "wrong_mode")
	future := time.Now().Add(21 * time.Second)
	h.now = func() time.Time { return future }
	h.Sweep()
	v, _ = h.Snapshot(r.Room.ID)
	if v.State != "running" {
		t.Fatal("stream incorrectly required lockstep frames")
	}
	h.Detach(guest)
	v, _ = h.Snapshot(r.Room.ID)
	if v.State != "running" || len(v.Players) != 1 {
		t.Fatal("stream guest departure ended the game")
	}
	g, err := h.Join(r.Room.ID, "late guest")
	if err != nil || g.Seat != 1 {
		t.Fatalf("late guest join: %v", err)
	}
	mustAttach(t, h, g)
	v, _ = h.Snapshot(r.Room.ID)
	if v.Players[1].Generation != 2 {
		t.Fatal("replacement reused connection generation")
	}
	h.Detach(host)
	v, _ = h.Snapshot(r.Room.ID)
	if v.State != "ended" {
		t.Fatal("host departure must end streaming")
	}
	_, err = h.Join(r.Room.ID, "too late")
	expectCode(t, err, "not_joinable")
}

func TestStreamHostStartsSoloAndPendingGuestDoesNotBlock(t *testing.T) {
	for _, pending := range []bool{false, true} {
		h, r, peers := streamRoom(t, 0)
		var reservationGuest reservation
		if pending {
			reservationGuest, _ = h.Join(r.Room.ID, "pending")
		}
		mustMessage(t, h, peers[0], clientMessage{Type: "prepare"})
		mustMessage(t, h, peers[0], clientMessage{Type: "ready"})
		mustMessage(t, h, peers[0], clientMessage{Type: "start"})
		if pending {
			future := time.Now().Add(121 * time.Second)
			h.now = func() time.Time { return future }
			h.Sweep()
			_, err := h.Attach(r.Room.ID, reservationGuest.Token)
			expectCode(t, err, "unauthorized")
		}
		v, _ := h.Snapshot(r.Room.ID)
		if v.State != "running" || len(v.Players) != 1 {
			t.Fatalf("solo stream: %+v", v)
		}
	}
}

func TestSignalRoutingAuthorizationAndGeneration(t *testing.T) {
	h, r, peers := streamRoom(t, 2)
	host, guest, other := peers[0], peers[1], peers[2]
	mustMessage(t, h, host, offer(1, 1, negotiationID))
	if len(drain(host)) != 0 || len(drain(other)) != 0 {
		t.Fatal("targeted signal was broadcast")
	}
	events := drain(guest)
	if len(events) != 1 || events[0]["type"] != "signal" || events[0]["from"] != float64(0) || events[0]["generation"] != float64(1) || events[0]["toGeneration"] != float64(1) {
		t.Fatalf("bad authenticated signal: %+v", events)
	}
	mustMessage(t, h, guest, answer(1, negotiationID))
	events = drain(host)
	if len(events) != 1 || events[0]["from"] != float64(1) {
		t.Fatal("answer lost authenticated sender")
	}
	mustMessage(t, h, host, candidate(1, 1, negotiationID))
	mustMessage(t, h, guest, candidate(0, 1, negotiationID))
	expectCode(t, h.Message(guest, candidate(2, 1, negotiationID)), "invalid_target")
	expectCode(t, h.Message(host, offer(0, 1, negotiationID)), "invalid_target")
	expectCode(t, h.Message(host, offer(4, 1, negotiationID)), "invalid_target")
	expectCode(t, h.Message(host, offer(3, 1, negotiationID)), "not_connected")
	expectCode(t, h.Message(host, offer(1, 0, negotiationID)), "stale_generation")
	secondRoom, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":9}`), "second host", "other")
	if err != nil {
		t.Fatal(err)
	}
	secondPeer := mustAttach(t, h, secondRoom)
	expectCode(t, h.Message(secondPeer, offer(1, 1, negotiationID)), "not_connected")
	if strictJSON([]byte(`{"type":"signal","from":0,"to":1}`), new(clientMessage)) == nil {
		t.Fatal("client may spoof signal sender")
	}
	oldGuest := guest
	h.Detach(guest)
	g, _ := h.Join(r.Room.ID, "replacement")
	guest = mustAttach(t, h, g)
	for _, p := range append(peers, guest) {
		drain(p)
	}
	expectCode(t, h.Message(host, offer(1, 1, negotiationID)), "stale_generation")
	expectCode(t, h.Message(oldGuest, answer(1, negotiationID)), "unauthorized")
	expectCode(t, h.Message(guest, answer(1, negotiationID)), "stale_negotiation")
	mustMessage(t, h, host, offer(1, 2, negotiationID))
	mustMessage(t, h, guest, answer(1, negotiationID))
	newID := strings.Repeat("a", 32)
	mustMessage(t, h, host, offer(1, 2, newID))
	expectCode(t, h.Message(guest, answer(1, negotiationID)), "stale_negotiation")
	expectCode(t, h.Message(host, candidate(1, 2, negotiationID)), "stale_negotiation")
	mustMessage(t, h, guest, answer(1, newID))
	h.Detach(host)
	expectCode(t, h.Message(guest, candidate(0, 1, newID)), "ended")
}

func TestSignalValidationAndResourceBounds(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*clientMessage)
	}{
		{"empty signal", func(m *clientMessage) { m.Signal = nil }},
		{"bad nonce", func(m *clientMessage) { m.Signal.ID = strings.Repeat("A", 32) }},
		{"invalid nonce", func(m *clientMessage) { m.Signal.ID = strings.Repeat("z", 32) }},
		{"no payload", func(m *clientMessage) { m.Signal.Description = nil }},
		{"both payloads", func(m *clientMessage) { m.Signal.Candidate = json.RawMessage(`null`) }},
		{"host answer", func(m *clientMessage) { m.Signal.Description.Type = "answer" }},
		{"empty SDP", func(m *clientMessage) { m.Signal.Description.SDP = "" }},
		{"large SDP", func(m *clientMessage) { m.Signal.Description.SDP = strings.Repeat("x", maxSDPBytes+1) }},
		{"candidate fields", func(m *clientMessage) {
			*m = candidate(1, 1, negotiationID)
			m.Signal.Candidate = json.RawMessage(`{"candidate":"x","secret":"x"}`)
		}},
		{"candidate index", func(m *clientMessage) {
			*m = candidate(1, 1, negotiationID)
			m.Signal.Candidate = json.RawMessage(`{"sdpMLineIndex":-1}`)
		}},
		{"candidate control", func(m *clientMessage) {
			*m = candidate(1, 1, negotiationID)
			m.Signal.Candidate = json.RawMessage(`{"candidate":"x\n"}`)
		}},
		{"candidate length", func(m *clientMessage) {
			*m = candidate(1, 1, negotiationID)
			m.Signal.Candidate, _ = json.Marshal(map[string]string{"candidate": strings.Repeat("x", 4097)})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, p := streamRoom(t, 1)
			m := offer(1, 1, negotiationID)
			tc.mutate(&m)
			expectCode(t, h.Message(p[0], m), "invalid_signal")
			if len(drain(p[1])) != 0 {
				t.Fatal("invalid signal reached peer")
			}
		})
	}
	h, _, peers := streamRoom(t, 1)
	mustMessage(t, h, peers[0], offer(1, 1, negotiationID))
	m := candidate(1, 1, negotiationID)
	m.Signal.Candidate = json.RawMessage(`null`)
	for i := 1; i < maxSignalsPerMinute; i++ {
		mustMessage(t, h, peers[0], m)
		drain(peers[1])
	}
	expectCode(t, h.Message(peers[0], m), "signal_rate_limit")
	future := time.Now().Add(time.Minute)
	h.now = func() time.Time { return future }
	mustMessage(t, h, peers[0], m)
	h, _, peers = streamRoom(t, 1)
	m = offer(1, 1, negotiationID)
	m.Signal.Description.SDP = strings.Repeat("x", maxSDPBytes)
	limited := false
	for i := 0; i < 60; i++ {
		err := h.Message(peers[0], m)
		if err != nil {
			expectCode(t, err, "signal_rate_limit")
			limited = true
			break
		}
		drain(peers[1])
	}
	if !limited {
		t.Fatal("signal byte rate limit absent")
	}
	legacyHub := newHub()
	r := mustRoom(t, legacyHub)
	p := mustAttach(t, legacyHub, r)
	expectCode(t, legacyHub.Message(p, offer(1, 1, negotiationID)), "wrong_mode")
}

func TestWireEnvelopeBoundAndConfigEscaping(t *testing.T) {
	h := newHub()
	r, err := h.Create("melee", json.RawMessage(`{"seed":1,"text":"`+strings.Repeat("<", 30000)+`"}`), "host", "test")
	if err != nil {
		t.Fatal(err)
	}
	p := mustAttach(t, h, r)
	select {
	case b := <-p.out:
		if len(b) > maxWireBytes || len(b) > 32000 || !json.Valid(b) {
			t.Fatalf("config inflated to %d bytes", len(b))
		}
	default:
		t.Fatal("missing room envelope")
	}
	if _, err := wireJSON(map[string]string{"large": strings.Repeat("x", maxWireBytes)}); err == nil {
		t.Fatal("oversized envelope accepted")
	}
	// Even JSON strings with control escapes cannot bypass the actual wire cap.
	p = &peer{out: make(chan []byte, 64), done: make(chan struct{})}
	p.send(map[string]string{"large": strings.Repeat("\x01", maxWireBytes/2)})
	select {
	case <-p.done:
	default:
		t.Fatal("oversized envelope did not close peer")
	}
	if len(p.out) != 0 {
		t.Fatal("oversized message reached queue")
	}
}

func TestStreamAuthorizationRequiresLiveCapability(t *testing.T) {
	h, r, p := streamRoom(t, 0)
	a, err := h.AuthorizeStream(r.Room.ID, r.Token)
	if err != nil || a.Seat != 0 || a.Mode != "host-stream" || !a.Connected || a.Generation != 1 {
		t.Fatalf("authorization: %+v %v", a, err)
	}
	_, err = h.AuthorizeStream(r.Room.ID, strings.Repeat("x", 43))
	expectCode(t, err, "unauthorized")
	g, _ := h.Join(r.Room.ID, "guest")
	_, err = h.AuthorizeStream(r.Room.ID, g.Token)
	expectCode(t, err, "unauthorized")
	guest := mustAttach(t, h, g)
	a, err = h.AuthorizeStream(r.Room.ID, g.Token)
	if err != nil || a.Seat != 1 {
		t.Fatal("guest authorization failed")
	}
	h.Detach(guest)
	_, err = h.AuthorizeStream(r.Room.ID, g.Token)
	expectCode(t, err, "unauthorized")
	h.Detach(p[0])
	_, err = h.AuthorizeStream(r.Room.ID, r.Token)
	expectCode(t, err, "unauthorized")
	legacy := mustRoom(t, h)
	mustAttach(t, h, legacy)
	_, err = h.AuthorizeStream(legacy.Room.ID, legacy.Token)
	expectCode(t, err, "unauthorized")
	for i := 0; i < 3; i++ {
		r, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":1}`), "host", fmt.Sprint(i))
		if err != nil {
			t.Fatal(err)
		}
		p := mustAttach(t, h, r)
		p.stop()
		_, err = h.AuthorizeStream(r.Room.ID, r.Token)
		expectCode(t, err, "unauthorized")
	}
}

// Tombstones may be retained for five minutes, but may never consume the last
// admission slots while no active game is using them.
func TestEndedRoomChurnCannotExhaustActiveRoomCapacity(t *testing.T) {
	h, active, peers := streamRoom(t, 0)
	now := time.Now()
	h.now = func() time.Time { return now }
	mustMessage(t, h, peers[0], clientMessage{Type: "prepare"})
	mustMessage(t, h, peers[0], clientMessage{Type: "ready"})
	mustMessage(t, h, peers[0], clientMessage{Type: "start"})
	drain(peers[0])
	old, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":1}`), "host", "churn")
	if err != nil {
		t.Fatal(err)
	}
	oldHost := mustAttach(t, h, old)
	guest, _ := h.Join(old.Room.ID, "guest")
	oldGuest := mustAttach(t, h, guest)
	h.Detach(oldHost)
	if view, err := h.Snapshot(old.Room.ID); err != nil || view.State != "ended" {
		t.Fatal("ended snapshot was not retained")
	}
	// First force capacity pressure before the normal five-minute expiry.
	for i := 0; i < maxRooms*2; i++ {
		now = now.Add(time.Millisecond)
		r, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":1}`), "host", "churn")
		if err != nil {
			t.Fatalf("ended-room churn exhausted capacity after %d: %v", i, err)
		}
		p := mustAttach(t, h, r)
		h.Detach(p)
	}
	if len(h.rooms) > maxRooms {
		t.Fatal("room map exceeded its bound")
	}
	if _, err := h.Snapshot(old.Room.ID); err == nil {
		t.Fatal("oldest tombstone did not yield its slot")
	}
	select {
	case <-oldGuest.done:
	default:
		t.Fatal("evicted tombstone retained a live transport")
	}
	view, err := h.Snapshot(active.Room.ID)
	if err != nil || view.State != "running" {
		t.Fatal("admission evicted an active game")
	}
	select {
	case <-peers[0].done:
		t.Fatal("active host was disconnected")
	default:
	}
	if _, err := h.CreateMode("melee", "host-stream", json.RawMessage(`{"seed":2}`), "unrelated", "another-client"); err != nil {
		t.Fatalf("unrelated player could not create a room: %v", err)
	}
}
