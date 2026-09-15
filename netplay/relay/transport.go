package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	webtransport "github.com/quic-go/webtransport-go"
)

type requestWindow struct {
	since time.Time
	count int
}
type relayServer struct {
	hub     *Hub
	wt      *webtransport.Server
	origins map[string]bool
	rateMu  sync.Mutex
	rates   map[string]requestWindow
}

func newRelayServer(hub *Hub, tlsConfig *tls.Config, origins []string) (*relayServer, error) {
	s := &relayServer{hub: hub, origins: make(map[string]bool), rates: make(map[string]requestWindow)}
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return nil, errors.New("allowed origins must be exact http(s) origins without trailing slash")
		}
		s.origins[origin] = true
	}
	if len(s.origins) == 0 {
		return nil, errors.New("at least one allowed origin is required")
	}
	h3 := &http3.Server{TLSConfig: http3.ConfigureTLSConfig(tlsConfig), Handler: s, MaxHeaderBytes: 8192, QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true, HandshakeIdleTimeout: 5 * time.Second, MaxIdleTimeout: 45 * time.Second, MaxIncomingStreams: 8, MaxIncomingUniStreams: 8, InitialStreamReceiveWindow: 64 * 1024, MaxStreamReceiveWindow: 128 * 1024, InitialConnectionReceiveWindow: 128 * 1024, MaxConnectionReceiveWindow: 256 * 1024}}
	s.wt = &webtransport.Server{H3: h3, CheckOrigin: s.allowedOrigin, ReorderingTimeout: 5 * time.Second, Config: &webtransport.Config{MaxIncomingStreams: 1, MaxIncomingUniStreams: -1, MaxIncomingData: 128 * 1024}}
	return s, nil
}
func (s *relayServer) allowedOrigin(r *http.Request) bool { return s.origins[r.Header.Get("Origin")] }
func (s *relayServer) allowRequest(address string) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	now := time.Now()
	for key, w := range s.rates {
		if now.Sub(w.since) > time.Minute {
			delete(s.rates, key)
		}
	}
	w, ok := s.rates[address]
	if !ok {
		if len(s.rates) >= 4096 {
			return false
		}
		w = requestWindow{since: now}
	}
	w.count++
	s.rates[address] = w
	return w.count <= 120
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, err error) {
	var e *protocolError
	if !errors.As(err, &e) {
		e = &protocolError{"internal", "Request could not be completed.", 500}
	}
	writeJSON(w, e.Status, map[string]string{"error": e.Message, "code": e.Code})
}
func strictJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("expected exactly one JSON object")
	}
	return nil
}
func bodyJSON(w http.ResponseWriter, r *http.Request, out any) error {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		return fail("invalid_body", "Content-Type must be application/json.", 415)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxConfigBytes+1024)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return fail("invalid_body", "Request body is too large.", 413)
	}
	if err := strictJSON(b, out); err != nil {
		return fail("invalid_body", "Expected one valid JSON object with known fields.", 400)
	}
	return nil
}
func (s *relayServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if s.allowedOrigin(r) {
		w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
		w.Header().Set("Vary", "Origin")
	}
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"ok": true, "protocol": 1})
		return
	}
	if r.Method == http.MethodOptions {
		if !s.allowedOrigin(r) {
			writeError(w, fail("origin", "Origin is not allowed.", 403))
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(204)
		return
	}
	if r.Method != http.MethodGet && !s.allowedOrigin(r) {
		writeError(w, fail("origin", "Origin is not allowed.", 403))
		return
	}
	address, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		address = r.RemoteAddr
	}
	if !s.allowRequest(address) {
		writeError(w, fail("rate_limit", "Too many relay requests. Try again shortly.", 429))
		return
	}
	if r.URL.Path == "/v1/connect" {
		if r.Method != http.MethodConnect {
			writeError(w, fail("method", "Use a WebTransport connection.", 405))
			return
		}
		s.connect(w, r)
		return
	}
	if r.URL.Path == "/v1/rooms" && r.Method == http.MethodPost {
		var body struct {
			Engine string          `json:"engine"`
			Mode   string          `json:"mode"`
			Config json.RawMessage `json:"config"`
			Name   string          `json:"name"`
		}
		if err := bodyJSON(w, r, &body); err != nil {
			writeError(w, err)
			return
		}
		v, err := s.hub.CreateMode(body.Engine, body.Mode, body.Config, body.Name, address)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 201, v)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "v1" && parts[1] == "rooms" && len(parts[2]) == 32 {
		if len(parts) == 3 && r.Method == http.MethodGet {
			v, err := s.hub.Snapshot(parts[2])
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 200, v)
			return
		}
		if len(parts) == 4 && parts[3] == "authorize" && r.Method == http.MethodPost {
			var body struct {
				Token string `json:"token"`
			}
			if err := bodyJSON(w, r, &body); err != nil {
				writeError(w, err)
				return
			}
			v, err := s.hub.AuthorizeStream(parts[2], body.Token)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 200, v)
			return
		}
		if len(parts) == 4 && parts[3] == "join" && r.Method == http.MethodPost {
			var body struct {
				Name string `json:"name"`
			}
			if err := bodyJSON(w, r, &body); err != nil {
				writeError(w, err)
				return
			}
			v, err := s.hub.Join(parts[2], body.Name)
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 201, v)
			return
		}
	}
	writeError(w, fail("not_found", "Endpoint does not exist.", 404))
}
func (s *relayServer) connect(w http.ResponseWriter, r *http.Request) {
	if len(r.URL.Query().Get("room")) != 32 || len(r.URL.Query().Get("token")) != 43 {
		writeError(w, fail("unauthorized", "Invalid room or token.", 403))
		return
	}
	c, err := s.hub.Attach(r.URL.Query().Get("room"), r.URL.Query().Get("token"))
	if err != nil {
		writeError(w, err)
		return
	}
	defer s.hub.Detach(c)
	session, err := s.wt.Upgrade(w, r)
	if err != nil {
		return
	}
	defer session.CloseWithError(0, "Session ended.")
	ctx, cancel := context.WithCancel(session.Context())
	defer cancel()
	go func() {
		select {
		case <-c.done:
			_ = session.CloseWithError(1, "Connection ended.")
		case <-ctx.Done():
		}
	}()
	streamCtx, stop := context.WithTimeout(ctx, 10*time.Second)
	stream, err := session.AcceptStream(streamCtx)
	stop()
	if err != nil {
		return
	}
	// Only one ordered control/input stream belongs to this protocol. Closing
	// the whole session rejects extra streams instead of accumulating buffers.
	go func() {
		if extra, err := session.AcceptStream(ctx); err == nil {
			extra.CancelRead(1)
			extra.CancelWrite(1)
			c.stop()
		}
	}()
	go func() {
		if extra, err := session.AcceptUniStream(ctx); err == nil {
			extra.CancelRead(1)
			c.stop()
		}
	}()
	go func() {
		if _, err := session.ReceiveDatagram(ctx); err == nil {
			c.stop()
		}
	}()
	go func() {
		defer c.stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-c.done:
				return
			case data := <-c.out:
				c.queued.Add(-int64(len(data)))
				_ = stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if _, err := stream.Write(data); err != nil {
					return
				}
			}
		}
	}()
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 1024), maxSignalBytes)
	window := time.Now()
	count := 0
	for {
		_ = stream.SetReadDeadline(time.Now().Add(45 * time.Second))
		if !scanner.Scan() {
			return
		}
		if time.Since(window) >= time.Second {
			window = time.Now()
			count = 0
		}
		count++
		if count > 240 {
			return
		}
		var message clientMessage
		if err := strictJSON(scanner.Bytes(), &message); err != nil {
			c.send(map[string]any{"type": "error", "code": "invalid_message", "message": "Malformed or unknown message fields."})
			continue
		}
		if message.Type != "signal" && len(scanner.Bytes()) >= 4096 {
			c.send(map[string]any{"type": "error", "code": "invalid_message", "message": "Non-signaling messages must be smaller than 4 KiB."})
			continue
		}
		if err := s.hub.Message(c, message); err != nil {
			var e *protocolError
			if errors.As(err, &e) {
				reply := map[string]any{"type": "error", "code": e.Code, "message": e.Message}
				if message.Type == "signal" {
					reply["request"] = "signal"
				}
				c.send(reply)
			} else {
				return
			}
		}
		if message.Type == "leave" {
			return
		}
	}
}
