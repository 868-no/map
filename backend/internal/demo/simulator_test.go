package demo

import (
	"testing"
	"time"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/security"
)

type ids map[uint32]security.Identity

func (m ids) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

// The demo must exercise the real verification paths and its adversarial
// inputs must be rejected.
func TestSimulatorThroughIngest(t *testing.T) {
	s := DefaultScenario()
	t.Log(s.Describe())
	kr, err := security.NewKeyring(Channels())
	if err != nil {
		t.Fatal(err)
	}
	store := ids{}
	o := ingest.Options{Keyring: kr, Identities: store, KeyBudget: 4}
	sim := NewSimulator(s, 1)
	accepted := map[string]int{}
	rejected := map[string]int{}
	notes := map[string]map[string]int{}
	firmware := map[string]int{}
	for range 3000 {
		for _, m := range sim.Step() {
			obs, err := ingest.Process(ingest.RawMessage{BrokerID: "demo", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()}, o)
			if notes[m.Note] == nil {
				notes[m.Note] = map[string]int{}
			}
			if err != nil {
				rejected[ingest.Category(err)]++
				notes[m.Note]["reject:"+ingest.Category(err)]++
				continue
			}
			if obs.Meta.Invalid != "" {
				notes[m.Note]["invalid"]++
			} else {
				notes[m.Note]["ok"]++
			}
			accepted[obs.PacketType+"/"+string(obs.SignatureStatus)+"/"+string(obs.Meta.Crypto)]++
			if mr := obs.Meta.MapReport; mr != nil {
				firmware[mr.FirmwareVersion]++
			}
			if obs.Promote != nil {
				store[obs.Promote.Node] = *obs.Promote
			}
		}
	}
	t.Logf("accepted: %v", accepted)
	t.Logf("rejected: %v", rejected)
	for k, v := range notes {
		t.Logf("note %q: %v", k, v)
	}
	for _, want := range []string{"nodeinfo/verified/ctr_unauthenticated", "position/verified/ctr_unauthenticated", "position/unsigned/ctr_unauthenticated",
		"traceroute/not-applicable/ctr_unauthenticated", "neighborinfo/verified/ctr_unauthenticated", "text/verified/ccm_authenticated", "telemetry/verified/plaintext_uplink"} {
		if accepted[want] == 0 {
			t.Errorf("demo never produced %s", want)
		}
	}
	if n := notes["forged signature (header only)"]; n["invalid"] == 0 || len(n) != 1 {
		t.Errorf("forged signatures should be header-only invalid rows: %v", n)
	}
	if notes["malformed protobuf"]["ok"] > 0 {
		t.Error("malformed input accepted")
	}
	if n := notes["PKI DM (header only)"]; n["ok"] == 0 || len(n) != 1 {
		t.Errorf("PKI DMs should be kept as header-only rows: %v", n)
	}
	if len(store) == 0 {
		t.Error("no identities learned")
	}
	// Gateways state their firmware in map reports (D-196): 2.8 when keyed, 2.4 when legacy.
	if n := notes["map report"]; n["ok"] == 0 || len(n) != 1 {
		t.Errorf("map reports should all be accepted: %v", n)
	}
	if firmware["2.8.1.demo"] == 0 || firmware["2.8.0.demo"] == 0 || firmware["2.4.3.demo"] == 0 || len(firmware) != 3 {
		t.Errorf("map reports' firmware versions: %v", firmware)
	}
}

func TestRelayByteMatchesFirmware(t *testing.T) {
	if relayByte(0x12345678) != 0x78 || relayByte(0x12345600) != 0xff {
		t.Fatal("relay byte must be the low byte, 0xff for a zero low byte")
	}
}
