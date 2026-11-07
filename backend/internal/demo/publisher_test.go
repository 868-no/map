package demo

import (
	"context"
	"errors"
	"testing"
)

// The demo publisher only ever talks to a local or private broker: a name
// is resolved, dotless ones too, and every address it has must be safe.
func TestSafeHost(t *testing.T) {
	dns := map[string][]string{
		"mosquitto":         {"172.18.0.4"},
		"localhost":         {"127.0.0.1", "::1"},
		"mqtt":              {"203.0.113.7"},              // a search domain found a public broker
		"split":             {"10.0.0.2", "198.51.100.9"}, // one public address is enough to refuse
		"broker.lan":        {"192.168.1.20"},
		"mqtt.example.org":  {"93.184.215.14"},
		"mapped-public":     {"::ffff:8.8.8.8"},
		"mapped-private":    {"::ffff:10.1.2.3"},
		"garbage-addresses": {"not-an-ip"},
	}
	old := lookupHost
	defer func() { lookupHost = old }()
	lookupHost = func(_ context.Context, host string) ([]string, error) {
		if a, ok := dns[host]; ok {
			return a, nil
		}
		return nil, errors.New("no such host")
	}
	for host, want := range map[string]bool{
		"127.0.0.1": true, "::1": true, "10.0.0.1": true, "fd00::1": true, "8.8.8.8": false, "2001:db8::1": false,
		"mosquitto": true, "localhost": true, "broker.lan": true, "mapped-private": true,
		"mqtt": false, "split": false, "mqtt.example.org": false, "mapped-public": false, "garbage-addresses": false,
	} {
		got, err := SafeHost(context.Background(), host)
		if err != nil || got != want {
			t.Errorf("SafeHost(%q) = %v, %v; want %v", host, got, err, want)
		}
	}
	if ok, err := SafeHost(context.Background(), "unknown"); ok || err == nil {
		t.Errorf("an unresolvable name: %v, %v; want refused with an error", ok, err)
	}
}
