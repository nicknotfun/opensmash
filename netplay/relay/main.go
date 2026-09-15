package main

import (
	"context"
	"crypto/tls"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	addr := os.Getenv("RELAY_ADDR")
	if addr == "" {
		addr = ":443"
	}
	certFile, keyFile := os.Getenv("RELAY_TLS_CERT"), os.Getenv("RELAY_TLS_KEY")
	if certFile == "" || keyFile == "" {
		log.Fatal("RELAY_TLS_CERT and RELAY_TLS_KEY are required")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Fatal("could not load TLS certificate: ", err)
	}
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}
	origins := strings.Split(os.Getenv("RELAY_ALLOWED_ORIGINS"), ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}
	hub := newHub()
	server, err := newRelayServer(hub, tlsConfig, origins)
	if err != nil {
		log.Fatal(err)
	}
	server.wt.H3.Addr = addr
	https := &http.Server{Addr: addr, Handler: server, TLSConfig: tlsConfig, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				hub.Sweep()
			case <-ctx.Done():
				return
			}
		}
	}()
	errs := make(chan error, 2)
	go func() { errs <- https.ListenAndServeTLS("", "") }()
	go func() { errs <- server.wt.ListenAndServe() }()
	log.Printf("relay listening on TCP and UDP %s", addr)
	failed := false
	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("relay stopped: %v", err)
			failed = true
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = https.Shutdown(shutdown)
	_ = server.wt.Close()
	if failed {
		os.Exit(1)
	}
}
