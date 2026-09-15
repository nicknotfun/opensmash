package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

type signalDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type signalCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type signalMessage struct {
	ID          string             `json:"id"`
	Description *signalDescription `json:"description,omitempty"`
	// RawMessage distinguishes an explicit end-of-candidates null from an
	// omitted field, while validation below rejects unknown candidate fields.
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

func validSignal(s *signalMessage, host bool) bool {
	if s == nil || len(s.ID) != 32 || strings.ToLower(s.ID) != s.ID {
		return false
	}
	if _, err := hex.DecodeString(s.ID); err != nil {
		return false
	}
	if (s.Description == nil) == (len(s.Candidate) == 0) {
		return false
	}
	if s.Description != nil {
		want := "answer"
		if host {
			want = "offer"
		}
		return s.Description.Type == want && len(s.Description.SDP) > 0 && len(s.Description.SDP) <= maxSDPBytes
	}
	if bytes.Equal(bytes.TrimSpace(s.Candidate), []byte("null")) {
		return true
	}
	if len(s.Candidate) > 8*1024 {
		return false
	}
	var c signalCandidate
	if err := strictJSON(s.Candidate, &c); err != nil {
		return false
	}
	if len(c.Candidate) > 4096 || strings.IndexFunc(c.Candidate, unicode.IsControl) >= 0 {
		return false
	}
	for _, field := range []*string{c.SDPMid, c.UsernameFragment} {
		if field != nil && (len(*field) > 256 || strings.IndexFunc(*field, unicode.IsControl) >= 0) {
			return false
		}
	}
	return c.SDPMLineIndex == nil || *c.SDPMLineIndex >= 0 && *c.SDPMLineIndex <= 65535
}

// signal routes negotiation only. Media and controller pads stay on the
// authenticated host/guest WebRTC connection, never in relay room broadcasts.
// The hub mutex protects room generations, offer nonces, and rate accounting.
func (r *room) signal(c *peer, m clientMessage, now time.Time) error {
	if r.mode != "host-stream" {
		return fail("wrong_mode", "Signaling requires a host-stream room.", 409)
	}
	if r.state == "ended" {
		return fail("ended", "This room has ended.", 409)
	}
	if m.To == nil || *m.To < 0 || *m.To >= maxPlayers || *m.To == c.seat || (c.seat != 0 && *m.To != 0) {
		return fail("invalid_target", "Signals may only pass between the host and one guest.", 400)
	}
	to := *m.To
	target := r.players[to]
	if target == nil || target.connection == nil {
		return fail("not_connected", "Signal recipient is not connected.", 409)
	}
	select {
	case <-target.connection.done:
		return fail("not_connected", "Signal recipient is disconnecting.", 409)
	default:
	}
	if m.Generation == 0 || m.Generation != r.generations[to] {
		return fail("stale_generation", "Signal recipient has changed; use its current generation.", 409)
	}
	if !validSignal(m.Signal, c.seat == 0) {
		return fail("invalid_signal", "Expected a bounded offer, answer, or ICE candidate with a negotiation id.", 400)
	}
	guest := c.seat
	if c.seat == 0 {
		guest = to
	}
	newOffer := c.seat == 0 && m.Signal.Description != nil
	if !newOffer && r.negotiations[guest] != m.Signal.ID {
		return fail("stale_negotiation", "Signal does not belong to the latest host offer.", 409)
	}
	envelope := map[string]any{"type": "signal", "from": c.seat, "generation": r.generations[c.seat], "toGeneration": r.generations[to], "signal": m.Signal}
	data, err := wireJSON(envelope)
	if err != nil || len(data) > maxSignalBytes {
		return fail("invalid_signal", "Signal envelope exceeds 64 KiB.", 400)
	}
	if c.signalWindow.IsZero() || now.Sub(c.signalWindow) >= time.Minute {
		c.signalWindow, c.signalCount, c.signalBytes = now, 0, 0
	}
	if c.signalCount >= maxSignalsPerMinute || c.signalBytes+len(data) > maxSignalBytesPerMinute {
		return fail("signal_rate_limit", "Too much signaling; wait before renegotiating.", 429)
	}
	c.signalCount++
	c.signalBytes += len(data)
	if newOffer {
		r.negotiations[guest] = m.Signal.ID
	}
	target.connection.send(envelope)
	return nil
}
