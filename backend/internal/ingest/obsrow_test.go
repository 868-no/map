package ingest

import (
	"encoding/json"
	"testing"
	"time"
)

func TestTailRoundTrip(t *testing.T) {
	gw := uint32(42)
	r := NewObsRow(RowFields{ID: 9, At: time.UnixMilli(1_800_000_000_123), Broker: "b", Gateway: &gw, Source: 7, Type: "position",
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
