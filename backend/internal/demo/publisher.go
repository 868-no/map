package demo

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
)

// SafeHost reports whether host is a compose service name (no dots) or
// resolves only to loopback/private addresses. The demo publisher refuses
// anything else so it can never inject simulated traffic into a live mesh.
func SafeHost(ctx context.Context, host string) (bool, error) {
	if host == "localhost" || !strings.Contains(host, ".") {
		if ip, err := netip.ParseAddr(host); err == nil {
			return ip.IsLoopback() || ip.IsPrivate(), nil
		}
		return true, nil
	}
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return false, err
	}
	for _, a := range addrs {
		ip, err := netip.ParseAddr(a)
		if err != nil || (!ip.IsLoopback() && !ip.IsPrivate()) {
			return false, nil //nolint:nilerr // an address that does not parse is not a safe one
		}
	}
	return len(addrs) > 0, nil
}

// PublishConfig configures the demo publisher.
type PublishConfig struct {
	Host          string
	Port          int
	Rate          float64 // simulation ticks per second
	Seed          uint64
	AllowExternal bool
	Log           *slog.Logger
}

// Publish runs the simulator against the demo broker until ctx ends.
func Publish(ctx context.Context, c PublishConfig) error {
	if !c.AllowExternal {
		ok, err := SafeHost(ctx, c.Host)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", c.Host, err)
		}
		if !ok {
			return fmt.Errorf("refusing to publish demo traffic to non-private host %q (use --allow-external only for an isolated test broker)", c.Host)
		}
	}
	u := &url.URL{Scheme: "mqtt", Host: fmt.Sprintf("%s:%d", c.Host, c.Port)}
	ready := make(chan struct{}, 1)
	cm, err := autopaho.NewConnection(ctx, autopaho.ClientConfig{
		ServerUrls: []*url.URL{u}, KeepAlive: 30, CleanStartOnInitialConnection: true, ConnectTimeout: 10 * time.Second,
		OnConnectionUp: func(*autopaho.ConnectionManager, *paho.Connack) {
			c.Log.Info("demo publisher connected", "broker", u.Host)
			select {
			case ready <- struct{}{}:
			default:
			}
		},
		OnConnectError: func(err error) { c.Log.Warn("demo broker connect failed", "err", err) },
		ClientConfig:   paho.ClientConfig{ClientID: fmt.Sprintf("meshmap-demo-%d", c.Seed)},
	})
	if err != nil {
		return err
	}
	select {
	case <-ready:
	case <-ctx.Done():
		return nil
	}
	s := DefaultScenario()
	c.Log.Info("demo scenario", "summary", s.Describe())
	sim := NewSimulator(s, c.Seed)
	tick := time.NewTicker(time.Duration(float64(time.Second) / max(c.Rate, 0.1)))
	defer tick.Stop()
	sent := 0
	for {
		select {
		case <-ctx.Done():
			_ = cm.Disconnect(context.Background())
			return nil
		case <-tick.C:
		}
		for _, m := range sim.Step() {
			pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_, err := cm.Publish(pctx, &paho.Publish{Topic: m.Topic, Payload: m.Payload, QoS: 0})
			cancel()
			if err != nil {
				c.Log.Warn("demo publish failed", "err", err)
				continue
			}
			sent++
		}
		if sent > 0 && sent%500 < 5 {
			c.Log.Info("demo progress", "messages", sent)
		}
	}
}
