package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func setup(t *testing.T, brokers, channels string) {
	dir := t.TempDir()
	t.Setenv("POSTGRES_PASSWORD", "s3cret-db-password")
	t.Setenv("MQTT_BROKERS_CONFIG", write(t, dir, "b.yaml", brokers))
	t.Setenv("CHANNEL_KEYS_CONFIG", write(t, dir, "c.yaml", channels))
}

const goodBrokers = `brokers:
  - id: no868
    host: mqtt.example.org
    username: example-user
    password: hunter2-broker
    topics: [{filter: "msh/EU_868/#", qos: 0}]
`

const goodChannels = `channels:
  - {name: NarrowFast, broker_ids: ["*"], mode: ctr, psks: ["AQ=="]}
  - {name: Private, broker_ids: [no868], mode: ccm, psks: ["hex:000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f"]}
`

func TestLoadValid(t *testing.T) {
	setup(t, goodBrokers, goodChannels)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Brokers[0].Port != 1883 || c.Brokers[0].Protocol != "v5" || c.Brokers[0].ClientID != "meshmap-no868" {
		t.Fatalf("defaults not applied: %+v", c.Brokers[0])
	}
	s := c.Summary()
	for _, secret := range []string{"hunter2-broker", "s3cret-db-password", "AQ==", "000102030405"} {
		if strings.Contains(s, secret) {
			t.Fatalf("summary leaks %q:\n%s", secret, s)
		}
	}
}

func TestLoadInvalidIsReadableAndRedacted(t *testing.T) {
	setup(t, `brokers:
  - id: "bad id!"
    host: ""
    password: hunter2-broker
    topics: []
  - id: dup
    host: a
    topics: [{filter: x}]
  - id: dup
    host: b
    protocol: v4
    topics: [{filter: x, qos: 2}]
`, `channels:
  - {name: X, psks: ["c2hvcnQ="]}
  - {name: Y, broker_ids: [nope], psks: ["AQ=="]}
`)
	_, err := Load()
	if err == nil {
		t.Fatal("expected errors")
	}
	msg := err.Error()
	for _, want := range []string{"id must match", "host is required", "duplicate id", "protocol must be v5 or v311", "qos must be 0 or 1", "PSK must decode", "unknown broker id"} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing %q in:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "hunter2") || strings.Contains(msg, "c2hvcnQ") {
		t.Fatalf("error leaks secrets:\n%s", msg)
	}
}

func TestDemoModeWithoutFiles(t *testing.T) {
	t.Setenv("POSTGRES_PASSWORD", "x")
	t.Setenv("DEMO_MODE", "true")
	t.Setenv("MQTT_BROKERS_CONFIG", "/nonexistent/b.yaml")
	t.Setenv("CHANNEL_KEYS_CONFIG", "/nonexistent/c.yaml")
	if _, err := Load(); err != nil {
		t.Fatalf("demo mode must boot without MQTT sources: %v", err)
	}
}

func TestProductionRequiresFiles(t *testing.T) {
	t.Setenv("POSTGRES_PASSWORD", "x")
	t.Setenv("MQTT_BROKERS_CONFIG", "/nonexistent/b.yaml")
	t.Setenv("CHANNEL_KEYS_CONFIG", "/nonexistent/c.yaml")
	if _, err := Load(); err == nil {
		t.Fatal("missing config must fail outside demo mode")
	}
}

// Compose-only deployments put the YAML in env vars; they replace the files.
func TestInlineYAMLReplacesFiles(t *testing.T) {
	t.Setenv("POSTGRES_PASSWORD", "s3cret-db-password")
	t.Setenv("MQTT_BROKERS_CONFIG", "/nonexistent/b.yaml")
	t.Setenv("CHANNEL_KEYS_CONFIG", "/nonexistent/c.yaml")
	t.Setenv("MQTT_BROKERS", goodBrokers)
	t.Setenv("CHANNEL_KEYS", goodChannels)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Brokers) != 1 || len(c.Channels) != 2 || c.Brokers[0].Password != "hunter2-broker" {
		t.Fatalf("inline config not used: %d brokers, %d channels", len(c.Brokers), len(c.Channels))
	}
	t.Setenv("CHANNEL_KEYS", "channels: {not: a list}")
	_, err = Load()
	if err == nil || !strings.Contains(err.Error(), "from CHANNEL_KEYS") {
		t.Fatalf("error should name the env var: %v", err)
	}
}

// The revision is public (part of the data generation): keyed with the
// database credentials, it cannot be recomputed from guessed channel keys.
func TestRevisionIsKeyedWithTheDatabaseSecret(t *testing.T) {
	c := &Config{Channels: []Channel{{Name: "LongFast", PSKs: []string{"AQ=="}}}}
	c.Env.PGPassword = "one"
	a := c.Revision()
	if a != c.Revision() {
		t.Fatal("revision is not stable")
	}
	c.Env.PGPassword = "two"
	two := c.Revision()
	if a == two {
		t.Fatal("revision does not depend on the database secret")
	}
	c.Channels[0].PSKs = []string{"secret"}
	three := c.Revision()
	if three == two || len(three) != 12 {
		t.Fatalf("revision %q does not follow the keys", three)
	}
	// The budget decides which packets decode when many keys are candidates.
	c.Env.KeyAttemptBudget = 8
	if c.Revision() == three {
		t.Fatal("revision does not follow KEY_ATTEMPT_BUDGET")
	}
}

// accept_plaintext is a *bool: the revision must hash its value, not the
// pointer, or every process (and restart) gets its own data generation.
func TestRevisionHashesAcceptPlaintextByValue(t *testing.T) {
	mk := func(v *bool) *Config {
		c := &Config{Channels: []Channel{{Name: "LongFast", PSKs: []string{"AQ=="}, AcceptPlaintext: v}}}
		c.Env.PGPassword = "pw"
		return c
	}
	f1, f2, t1 := false, false, true
	if mk(&f1).Revision() != mk(&f2).Revision() {
		t.Fatal("equal accept_plaintext values with distinct pointers give different revisions")
	}
	if mk(&f1).Revision() == mk(&t1).Revision() {
		t.Fatal("revision does not follow accept_plaintext")
	}
	if mk(nil).Revision() != mk(&t1).Revision() {
		t.Fatal("unset accept_plaintext must hash as its default (true)")
	}
}

// Each /observations read holds an API pool connection; reads may not take
// the connections health checks and light queries need.
func TestReadSlotsFitTheAPIPool(t *testing.T) {
	setup(t, goodBrokers, goodChannels)
	t.Setenv("DB_API_CONNS", "10")
	t.Setenv("API_READ_SLOTS", "9")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "API_READ_SLOTS (9) must be at most DB_API_CONNS - 2 (8)") {
		t.Fatalf("got %v", err)
	}
	t.Setenv("API_READ_SLOTS", "8")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
