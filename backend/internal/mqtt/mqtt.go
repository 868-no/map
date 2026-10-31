// Package mqtt runs read-only subscriptions to the configured brokers.
// Clients never publish: no publish method is exposed by this package.
package mqtt

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/url"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/observability"
)

// MaxPayload bounds messages handed to the pipeline; larger ones are counted
// and dropped here so oversize garbage never reaches the queue.
const MaxPayload = 4096

// Handler receives raw messages; it must not block (Pipeline.Submit).
type Handler func(ingest.RawMessage)

// ConnState is a broker connection state for readiness and status output.
type ConnState int32

const (
	StateConnecting ConnState = iota
	StateUp
	StateDown
)

func (s ConnState) String() string { return [...]string{"connecting", "up", "down"}[s] }

// Client is one broker subscription.
type Client interface {
	ID() string
	Run(ctx context.Context) error
	State() ConnState
}

type base struct {
	cfg    config.Broker
	handle Handler
	m      *observability.Metrics
	log    *slog.Logger
	state  atomic.Int32
}

func (b *base) ID() string       { return b.cfg.ID }
func (b *base) State() ConnState { return ConnState(b.state.Load()) }
func (b *base) setState(s ConnState) {
	b.state.Store(int32(s))
	v := 0.0
	if s == StateUp {
		v = 1
	}
	b.m.BrokerUp.WithLabelValues(b.cfg.ID).Set(v)
}

// deliver is called from the MQTT library's receive path. ObservedAt is
// stamped here, before queuing (spec §4.1).
func (b *base) deliver(topic string, payload []byte, retained bool) {
	now := time.Now().UTC()
	b.m.Received.WithLabelValues(b.cfg.ID).Inc()
	if len(payload) > MaxPayload {
		b.m.Rejected.WithLabelValues("oversize").Inc()
		return
	}
	b.handle(ingest.RawMessage{
		BrokerID: b.cfg.ID, Topic: topic, Payload: append([]byte(nil), payload...),
		Retained: retained, ObservedAt: now,
	})
}

// New builds the client implementation for the configured protocol.
func New(cfg config.Broker, h Handler, m *observability.Metrics, log *slog.Logger) (Client, error) {
	b := &base{cfg: cfg, handle: h, m: m, log: log.With("broker", cfg.ID)}
	b.setState(StateConnecting)
	switch cfg.Protocol {
	case "v311":
		return &v3Client{base: b}, nil
	case "v5", "":
		return &v5Client{base: b}, nil
	}
	return nil, fmt.Errorf("broker %s: unsupported protocol %q", cfg.ID, cfg.Protocol)
}

func tlsConfig(c config.Broker) (*tls.Config, error) {
	if !c.TLS.Enabled {
		return nil, nil
	}
	t := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: c.TLS.InsecureSkipVerify, ServerName: c.TLS.ServerName} //nolint:gosec // operator opt-in
	if t.ServerName == "" {
		t.ServerName = c.Host
	}
	if c.TLS.CAFile != "" {
		pem, err := os.ReadFile(c.TLS.CAFile)
		if err != nil {
			return nil, fmt.Errorf("broker %s: read CA: %w", c.ID, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("broker " + c.ID + ": no certificates in CA file")
		}
		t.RootCAs = pool
	}
	return t, nil
}

func brokerURL(c config.Broker) *url.URL {
	scheme := "mqtt"
	if c.TLS.Enabled {
		scheme = "tls"
	}
	return &url.URL{Scheme: scheme, Host: c.Host + ":" + strconv.Itoa(c.Port)}
}

// Backoff is full-jitter exponential backoff from 1 s to 60 s (spec §3.4).
func Backoff(attempt int) time.Duration {
	d := time.Second << min(attempt, 6)
	if d > time.Minute {
		d = time.Minute
	}
	return time.Duration(rand.Int64N(int64(d))) + 500*time.Millisecond
}
