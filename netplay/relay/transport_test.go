package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	webtransport "github.com/quic-go/webtransport-go"
)

const testOrigin = "https://game.example.test"

func TestRESTOriginLimitsAndNoTokenDisclosure(t *testing.T) {
	s, err := newRelayServer(newHub(), &tls.Config{}, []string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body, origin string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request("OPTIONS", "/v1/rooms", "", testOrigin); w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatal("preflight failed")
	}
	for _, origin := range []string{"", "null", "https://evil.test"} {
		if w := request("POST", "/v1/rooms", `{"engine":"melee","config":{"seed":7}}`, origin); w.Code != 403 {
			t.Fatalf("allowed hostile origin %q: %d", origin, w.Code)
		}
	}
	w := request("POST", "/v1/rooms", `{"engine":"melee","config":{"seed":7}}`, testOrigin)
	if w.Code != 201 {
		t.Fatalf("create: %s", w.Body.String())
	}
	var r reservation
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	w = request("GET", "/v1/rooms/"+r.Room.ID, "", testOrigin)
	if w.Code != 200 || strings.Contains(w.Body.String(), r.Token) || w.Header().Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatal("bad snapshot CORS or token disclosure")
	}
	if w := request("POST", "/v1/rooms/"+r.Room.ID+"/join", `{"seat":0}`, testOrigin); w.Code != 400 {
		t.Fatal("accepted seat assignment from client")
	}
	if w := request("POST", "/v1/rooms", strings.Repeat("x", maxConfigBytes+1025), testOrigin); w.Code != 413 {
		t.Fatal("accepted oversized body")
	}
	if w := request("GET", "/healthz", "", ""); w.Code != 200 {
		t.Fatal("health check failed")
	}
	for i := 0; i < 125; i++ {
		w = request("GET", "/v1/rooms/"+r.Room.ID, "", testOrigin)
	}
	if w.Code != 429 {
		t.Fatal("rate limit not applied")
	}
}

func testTLS(t *testing.T) (*tls.Config, *tls.Config) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: serial, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13}, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}
}

type wirePeer struct {
	session *webtransport.Session
	stream  *webtransport.Stream
	reader  *bufio.Reader
}

func (p *wirePeer) send(t *testing.T, value any) {
	t.Helper()
	_ = p.stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewEncoder(p.stream).Encode(value); err != nil {
		t.Fatal(err)
	}
}
func (p *wirePeer) event(t *testing.T, kind string) map[string]json.RawMessage {
	t.Helper()
	for i := 0; i < 30; i++ {
		_ = p.stream.SetReadDeadline(time.Now().Add(5 * time.Second))
		line, err := p.reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("waiting for %s: %v", kind, err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatal(err)
		}
		var typ string
		_ = json.Unmarshal(m["type"], &typ)
		if typ == kind {
			return m
		}
	}
	t.Fatalf("did not receive %s", kind)
	return nil
}

// This test opens real UDP sockets, negotiates TLS and HTTP/3, upgrades actual
// WebTransport sessions, and exchanges application frames. It uses no mock
// transport and trusts only its freshly generated local certificate.
func TestWebTransportQUICMatchAndDisconnect(t *testing.T) {
	serverTLS, clientTLS := testTLS(t)
	s, err := newRelayServer(newHub(), serverTLS, []string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- s.wt.Serve(udp) }()
	t.Cleanup(func() {
		_ = s.wt.Close()
		_ = udp.Close()
		select {
		case <-serveDone:
		case <-time.After(5 * time.Second):
			t.Error("relay did not stop")
		}
	})
	https := httptest.NewUnstartedServer(s)
	https.TLS = serverTLS.Clone()
	https.StartTLS()
	defer https.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: clientTLS.Clone()}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	post := func(path string, body any) reservation {
		t.Helper()
		data, _ := json.Marshal(body)
		req, err := http.NewRequest("POST", https.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", testOrigin)
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 201 {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("REST %d: %s", response.StatusCode, body)
		}
		var r reservation
		if err := json.NewDecoder(response.Body).Decode(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	host := post("/v1/rooms", map[string]any{"engine": "melee", "config": map[string]any{"seed": 12345}})
	guest := post("/v1/rooms/"+host.Room.ID+"/join", map[string]any{"name": "Guest"})
	transport := &webtransport.Transport{TLSClientConfig: clientTLS.Clone()}
	defer transport.Close()
	dial := func(r reservation, origin string) (*http.Response, *webtransport.Session, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		headers := http.Header{}
		if origin != "" {
			headers.Set("Origin", origin)
		}
		return transport.Dial(ctx, "https://"+udp.LocalAddr().String()+"/v1/connect?room="+r.Room.ID+"&token="+r.Token, headers)
	}
	bad := host
	bad.Token = strings.Repeat("x", 43)
	response, session, err := dial(bad, testOrigin)
	if err == nil || session != nil || response == nil || response.StatusCode != 403 {
		t.Fatalf("unauthorized QUIC session accepted: %v %v", response, err)
	}
	response, session, err = dial(host, "https://evil.test")
	if err == nil || session != nil || response == nil || response.StatusCode != 403 {
		t.Fatalf("cross-origin QUIC session accepted: %v %v", response, err)
	}
	connect := func(r reservation) *wirePeer {
		t.Helper()
		_, session, err := dial(r, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.CloseWithError(0, "test finished") })
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		stream, err := session.OpenStreamSync(ctx)
		if err != nil {
			t.Fatal(err)
		}
		p := &wirePeer{session, stream, bufio.NewReader(stream)}
		p.send(t, map[string]any{"type": "hello"})
		p.event(t, "room")
		return p
	}
	p0, p1 := connect(host), connect(guest)
	response, session, err = dial(host, testOrigin)
	if err == nil || session != nil || response == nil || response.StatusCode != 409 {
		t.Fatal("duplicate seat session accepted")
	}
	p0.send(t, map[string]any{"type": "prepare"})
	for _, p := range []*wirePeer{p0, p1} {
		event := p.event(t, "prepare")
		if string(event["seed"]) != "12345" {
			t.Fatal("prepare changed seed")
		}
	}
	p0.send(t, map[string]any{"type": "ready", "fingerprint": "build-assets-rom-v1"})
	p1.send(t, map[string]any{"type": "ready", "fingerprint": "build-assets-rom-v1"})
	// Read readiness snapshots until both acknowledgments reached the server.
	for {
		event := p0.event(t, "room")
		var view roomView
		_ = json.Unmarshal(event["room"], &view)
		if len(view.Players) == 2 && view.Players[0].Ready && view.Players[1].Ready {
			break
		}
	}
	p0.send(t, map[string]any{"type": "start"})
	for _, p := range []*wirePeer{p0, p1} {
		event := p.event(t, "start")
		if string(event["epoch"]) != "1" || string(event["seed"]) != "12345" {
			t.Fatal("bad start")
		}
	}
	p1.send(t, map[string]any{"type": "input", "epoch": 1, "tick": 0, "seat": 0, "pad": []int{9, 0, 0, 0, 0, 0, 0}})
	p1.event(t, "error")
	p0.send(t, map[string]any{"type": "input", "epoch": 1, "tick": 0, "pad": []int{1, 20, -30, 0, 0, 0, 0}})
	p1.send(t, map[string]any{"type": "input", "epoch": 1, "tick": 0, "pad": []int{2, -40, 50, 0, 0, 0, 0}})
	var first []byte
	for _, p := range []*wirePeer{p0, p1} {
		event := p.event(t, "frame")
		if string(event["tick"]) != "0" {
			t.Fatal("wrong tick")
		}
		var pads [4]Pad
		if err := json.Unmarshal(event["pads"], &pads); err != nil {
			t.Fatal(err)
		}
		if pads[0][0] != 1 || pads[1][0] != 2 || pads[2] != (Pad{}) || pads[3] != (Pad{}) {
			t.Fatal("incorrect seat ownership or neutral inputs")
		}
		if first == nil {
			first = event["pads"]
		} else if !bytes.Equal(first, event["pads"]) {
			t.Fatal("peers received different frames")
		}
	}
	_ = p1.session.CloseWithError(0, "disconnect test")
	p0.event(t, "ended")

	// The same real transport must carry SDP larger than the old 4 KiB input
	// limit, authenticate answers, and admit replacement streaming guests.
	streamHost := post("/v1/rooms", map[string]any{"engine": "melee", "mode": "host-stream", "config": map[string]any{"seed": 55}})
	streamGuest := post("/v1/rooms/"+streamHost.Room.ID+"/join", map[string]any{"name": "Viewer"})
	q0, q1 := connect(streamHost), connect(streamGuest)
	q0.send(t, offer(1, 1, negotiationID))
	event := q1.event(t, "signal")
	if string(event["from"]) != "0" || string(event["generation"]) != "1" || string(event["toGeneration"]) != "1" {
		t.Fatal("bad signal identity")
	}
	q1.send(t, answer(1, negotiationID))
	event = q0.event(t, "signal")
	if string(event["from"]) != "1" {
		t.Fatal("bad answer identity")
	}
	largeOffer := offer(1, 1, strings.Repeat("a", 32))
	largeOffer.Signal.Description.SDP = "v=0\r\n" + strings.Repeat("a", 16*1024)
	q0.send(t, largeOffer)
	event = q1.event(t, "signal")
	var received signalMessage
	if err := json.Unmarshal(event["signal"], &received); err != nil || received.Description == nil || received.Description.SDP != largeOffer.Signal.Description.SDP {
		t.Fatal("large SDP failed roundtrip")
	}
	q0.send(t, map[string]any{"type": "prepare"})
	q0.send(t, map[string]any{"type": "ready"})
	q0.send(t, map[string]any{"type": "start"})
	q0.event(t, "start")
	q1.event(t, "start")
	_ = q1.session.CloseWithError(0, "stream guest left")
	for {
		event = q0.event(t, "room")
		var view roomView
		_ = json.Unmarshal(event["room"], &view)
		if len(view.Players) == 1 {
			if view.State != "running" {
				t.Fatal("stream guest ended match")
			}
			break
		}
	}
	replacement := post("/v1/rooms/"+streamHost.Room.ID+"/join", map[string]any{"name": "Replacement"})
	q2 := connect(replacement)
	q0.send(t, offer(1, 1, negotiationID))
	event = q0.event(t, "error")
	if string(event["code"]) != `"stale_generation"` {
		t.Fatalf("stale offer accepted: %s", event["code"])
	}
	q0.send(t, offer(1, 2, negotiationID))
	q2.event(t, "signal")
	_ = q0.session.CloseWithError(0, "stream host left")
	q2.event(t, "ended")
}

func TestRESTStreamModeAndCredentialAuthorization(t *testing.T) {
	h := newHub()
	s, err := newRelayServer(h, &tls.Config{}, []string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	request := func(path string, body any, origin string) *httptest.ResponseRecorder {
		t.Helper()
		data, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", path, bytes.NewReader(data))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		return w
	}
	for _, mode := range []string{"invalid", "host-stream"} {
		w := request("/v1/rooms", map[string]any{"engine": "ssb64", "mode": mode, "config": map[string]any{"seed": 1}}, testOrigin)
		if w.Code != 400 {
			t.Fatalf("invalid mode accepted: %d", w.Code)
		}
	}
	w := request("/v1/rooms", map[string]any{"engine": "melee", "mode": "host-stream", "config": map[string]any{"seed": 1}}, testOrigin)
	if w.Code != 201 {
		t.Fatalf("stream create: %s", w.Body.String())
	}
	var r reservation
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	path := "/v1/rooms/" + r.Room.ID + "/authorize"
	if w := request(path, map[string]string{"token": r.Token}, testOrigin); w.Code != 403 {
		t.Fatal("unconnected capability authorized")
	}
	p := mustAttach(t, h, r)
	w = request(path, map[string]string{"token": r.Token}, testOrigin)
	if w.Code != 200 || strings.Contains(w.Body.String(), r.Token) {
		t.Fatalf("authorization leaked or failed: %s", w.Body.String())
	}
	var a streamAuthorization
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil || a.Mode != "host-stream" || a.Seat != 0 || !a.Connected || a.Generation != 1 {
		t.Fatalf("authorization reply: %+v %v", a, err)
	}
	if w := request(path, map[string]string{"token": r.Token}, ""); w.Code != 403 {
		t.Fatal("authorization omitted origin")
	}
	if w := request(path, map[string]string{"token": r.Token, "seat": "0"}, testOrigin); w.Code != 400 {
		t.Fatal("authorization accepted spoofed field")
	}
	h.Detach(p)
	if w := request(path, map[string]string{"token": r.Token}, testOrigin); w.Code != 403 {
		t.Fatal("ended capability authorized")
	}
}
