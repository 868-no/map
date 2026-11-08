//go:build integration

package integration

import (
	"context"
	"encoding/base64"
	"fmt"
	"hash/crc32"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/868-no/map/internal/ingest"
)

// D-198: the mesh's nodes by firmware, hardware, role and preset per bucket,
// from the hourly summaries: each node with the values it had then, a
// NodeInfo marked untrusted never counting, nor an invalid row as hearing.
func TestFleetTrends(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	nodeK := int64(crc32.ChecksumIEEE(key)) // its id is derived from its key: 2.8 or later
	const nodeR = int64(0x0b00000b)
	n := 0
	type opt struct {
		channel  string
		hopStart bool
	}
	row := func(node int64, typ string, at time.Time, meta string, o opt) {
		t.Helper()
		n++
		var ch, hs any
		if o.channel != "" {
			ch = o.channel
		}
		if o.hopStart {
			hs = 3
		}
		if _, err := pool.Exec(ctx, `INSERT INTO packet_log (observed_at, broker_id, mqtt_topic, gateway_node_id, source_node_id, packet_type, channel_name, hop_start,
			logical_packet_key, observation_key, signature_status, decode_version, envelope_bytes, decoded_metadata)
			VALUES ($1, 't', 'msh/EU_868/2/e/x', 99, $2, $3, $4, $5, $6, $6, 'unsigned', $7, '\x00', $8::jsonb)`,
			at, node, typ, ch, hs, []byte(fmt.Sprint(n)), ingest.DecodeVersion, meta); err != nil {
			t.Fatal(err)
		}
	}
	day := func(d int, h time.Duration) time.Time { return base.Add(time.Duration(d)*24*time.Hour + h*time.Hour) }
	b64 := base64.StdEncoding.EncodeToString(key)
	// Day 0: K a client with its key on LongFast; R a router without a key, on a
	// custom channel and without hop starts.
	row(nodeK, "nodeinfo", day(0, 9), `{"nodeinfo": {"role": "CLIENT", "hw_model": "HELTEC_V3", "public_key": "`+b64+`"}}`, opt{"LongFast", true})
	row(nodeK, "text", day(0, 10), `{}`, opt{"LongFast", true})
	row(nodeR, "nodeinfo", day(0, 9), `{"nodeinfo": {"role": "ROUTER", "hw_model": "RAK4631"}}`, opt{"Hytta", false})
	row(nodeR, "text", day(0, 11), `{}`, opt{"Hytta", false})
	// Day 1: K claims to be a router in an untrusted NodeInfo (ignored), and
	// its named map report states 2.7.15 and proves Medium Fast. R is heard
	// only in an invalid row: not heard.
	row(nodeK, "nodeinfo", day(1, 8), `{"nodeinfo": {"role": "ROUTER", "hw_model": "TBEAM", "identity_untrusted": true}}`, opt{"LongFast", true})
	row(nodeK, "mapreport", day(1, 9), `{"mapreport": {"long_name": "K", "role": "CLIENT", "hw_model": "HELTEC_V3", "firmware_version": "2.7.15.567b8ea", "modem_preset": "MEDIUM_FAST", "has_default_channel": true}}`, opt{})
	row(nodeR, "invalid", day(1, 9), `{}`, opt{"Hytta", false})
	// Day 2: R now ROUTER_LATE, and sends with a hop start.
	row(nodeR, "nodeinfo", day(2, 9), `{"nodeinfo": {"role": "ROUTER_LATE", "hw_model": "RAK4631"}}`, opt{"Hytta", true})

	c := newAPI(t, pool, nil, day(2, 12))
	type dim struct {
		Values []struct{ Name, Kind, Basis string }
	}
	var got struct {
		Firmware, Hardware, Role, Preset dim
		Buckets                          []struct {
			Start                            time.Time
			Nodes                            int
			Firmware, Hardware, Role, Preset []int
		}
	}
	if code := c.get("/api/v1/trends/fleet", url.Values{"bucket": {"day"}, "tz": {"UTC"}}, &got); code != 200 || len(got.Buckets) != 3 {
		t.Fatalf("HTTP %d: %+v", code, got)
	}
	// count is a bucket's nodes with a value of a dimension.
	count := func(d dim, counts []int, name string) int {
		for i, v := range d.Values {
			if v.Name == name {
				return counts[i]
			}
		}
		return 0
	}
	b0, b1, b2 := got.Buckets[0], got.Buckets[1], got.Buckets[2]
	if !b0.Start.Equal(base) || b0.Nodes != 2 || count(got.Firmware, b0.Firmware, "key") != 1 || count(got.Firmware, b0.Firmware, "no_hop_start") != 1 ||
		count(got.Role, b0.Role, "CLIENT") != 1 || count(got.Role, b0.Role, "ROUTER") != 1 || count(got.Hardware, b0.Hardware, "RAK4631") != 1 ||
		count(got.Preset, b0.Preset, "LONG_FAST") != 1 || count(got.Preset, b0.Preset, "unknown") != 1 {
		t.Fatalf("day 0: %+v\n%+v %+v %+v %+v", b0, got.Firmware, got.Hardware, got.Role, got.Preset)
	}
	if b1.Nodes != 1 || count(got.Firmware, b1.Firmware, "2.7") != 1 || count(got.Preset, b1.Preset, "MEDIUM_FAST") != 1 ||
		count(got.Role, b1.Role, "CLIENT") != 1 || count(got.Role, b1.Role, "ROUTER") != 0 || count(got.Hardware, b1.Hardware, "TBEAM") != 0 {
		t.Fatalf("day 1 (the untrusted NodeInfo and the invalid row must not count): %+v", b1)
	}
	if b2.Nodes != 1 || count(got.Role, b2.Role, "ROUTER_LATE") != 1 || count(got.Firmware, b2.Firmware, "unknown") != 1 {
		t.Fatalf("day 2: %+v", b2)
	}
	for _, v := range got.Firmware.Values {
		if v.Name == "2.7" && (v.Kind != "value" || v.Basis != "reported") || v.Name == "key" && v.Basis != "key" {
			t.Fatalf("firmware values: %+v", got.Firmware.Values)
		}
	}
	for _, b := range got.Buckets {
		sum := 0
		for _, v := range b.Role {
			sum += v
		}
		if sum != b.Nodes {
			t.Fatalf("roles do not sum to the nodes: %+v", b)
		}
	}
	if code := c.get("/api/v1/trends/fleet", url.Values{"bucket": {"month"}, "tz": {"Europe/Oslo"}}, &got); code != 200 || len(got.Buckets) != 2 || got.Buckets[0].Nodes != 2 {
		t.Fatalf("month: HTTP %d %+v", code, got.Buckets)
	}
	for _, q := range []url.Values{{"tz": {"Mars/Olympus"}}, {"bucket": {"year"}}} {
		if code := c.get("/api/v1/trends/fleet", q, nil); code != 400 && code != 422 {
			t.Fatalf("%v: HTTP %d", q, code)
		}
	}
	resp, err := http.Get(c.srv.URL + "/api/v1/trends/fleet")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=3600, stale-while-revalidate=86400" {
		t.Fatalf("Cache-Control %q", cc)
	}
}
