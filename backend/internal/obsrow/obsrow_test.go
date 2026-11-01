package obsrow

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestTailRoundTrip(t *testing.T) {
	gw := uint32(42)
	r := New(Fields{ID: 9, At: time.UnixMilli(1_800_000_000_123), Broker: "b", Gateway: &gw, Source: 7, Type: "position",
		Logical: []byte{1, 2}, Reception: []byte{3}, Sig: "unsigned"},
		[]byte(`{"topic_root":"msh/EU_868","position":{"lat":63.5,"lon":10.25,"precision_bits":13,"precision_known":true}}`))
	tail, err := EncodeTail(r)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(r)
	if got := WithID(9, tail); string(got) != string(want) {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// A map report's identity and has_default_channel reach the row (version 3):
// the browser names nodes heard only through their own map reports, and
// trusts the reported preset only when a default channel proves it is used.
func TestMapReportRowCarriesIdentity(t *testing.T) {
	r := New(Fields{ID: 1, At: time.UnixMilli(1_800_000_000_000), Source: 7, Type: "mapreport", Sig: "not-applicable"},
		[]byte(`{"mapreport":{"role":"CLIENT_BASE","region":"EU_868","hw_model":"SEEED_XIAO_S3","long_name":"NT Motorklubb","short_name":"NTMK","modem_preset":"LONG_FAST","firmware_version":"2.7.19","online_local_nodes":1}}`))
	want := ObsMapReport{Region: "EU_868", ModemPreset: "LONG_FAST", LongName: "NT Motorklubb", ShortName: "NTMK", HwModel: "SEEED_XIAO_S3", Role: "CLIENT_BASE"}
	if r.MapReport == nil || *r.MapReport != want {
		t.Fatalf("map report %+v, want %+v", r.MapReport, want)
	}
	b, _ := json.Marshal(r)
	if bytes.Contains(b, []byte("firmware_version")) || bytes.Contains(b, []byte("online_local_nodes")) {
		t.Fatalf("row carries fields the browser does not use: %s", b)
	}
}
