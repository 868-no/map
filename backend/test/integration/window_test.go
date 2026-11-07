//go:build integration

package integration

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/testutil"
	"github.com/868-no/map/internal/window"
)

// fixture builds protocol-correct envelopes and stores them at chosen
// observed_at instants through the production Process + InsertBatch path.
type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	kr   *security.Keyring
	ids  map[uint32]security.Identity
	pid  uint32
}

func (m fixtureIDs) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

type fixtureIDs map[uint32]security.Identity

func newFixture(t *testing.T, pool *pgxpool.Pool) *fixture {
	kr, err := security.NewKeyring([]security.ChannelConfig{{Name: "LongFast", PSKs: []string{"AQ=="}}})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, pool: pool, kr: kr, ids: map[uint32]security.Identity{}, pid: 1000}
}

func (f *fixture) store(at time.Time, from uint32, gw uint32, d *pb.Data, key *testutil.XKey) {
	f.t.Helper()
	obs := f.observation(at, from, gw, d, key)
	if _, err := storage.InsertBatch(context.Background(), f.pool, []*ingest.Observation{obs}); err != nil {
		f.t.Fatal(err)
	}
}

// observation decodes a packet as ingest would, without storing it.
func (f *fixture) observation(at time.Time, from uint32, gw uint32, d *pb.Data, key *testutil.XKey) *ingest.Observation {
	f.t.Helper()
	f.pid++
	if key != nil {
		d.XeddsaSignature = ed25519.Sign(key.EdPriv, security.SigningBuffer(from, f.pid, protocol.Broadcast, d))
	}
	pt, _ := proto.Marshal(d)
	ct, _ := security.EncryptCTR(security.DefaultPSK[:], from, f.pid, pt)
	rssi := int32(-90)
	mp := &pb.MeshPacket{From: from, To: protocol.Broadcast, Id: f.pid, Channel: uint32(security.ChannelHash("LongFast", security.DefaultPSK[:], security.ModeCTR)),
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, HopStart: 3, HopLimit: 3, RxSnr: 5, RxRssi: &rssi, TransportMechanism: pb.MeshPacket_TRANSPORT_LORA}
	env, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "LongFast", GatewayId: protocol.NodeID(gw)})
	obs, err := ingest.Process(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/e/LongFast/" + protocol.NodeID(gw), Payload: env, ObservedAt: at},
		ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4})
	if err != nil {
		f.t.Fatalf("process: %v", err)
	}
	if obs.Promote != nil {
		f.ids[obs.Promote.Node] = *obs.Promote
	}
	return &obs
}

func (f *fixture) nodeInfo(at time.Time, from, gw uint32, name string) {
	b, _ := proto.Marshal(&pb.User{LongName: name, ShortName: name[:2]})
	f.store(at, from, gw, &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b}, nil)
}

func (f *fixture) position(at time.Time, from, gw uint32, lat float64) {
	la, lo := int32(lat*1e7), int32(10.4*1e7)
	b, _ := proto.Marshal(&pb.Position{LatitudeI: &la, LongitudeI: &lo, PrecisionBits: 32})
	f.store(at, from, gw, &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: b}, nil)
}

func (f *fixture) telemetry(at time.Time, from, gw uint32, battery uint32) {
	b, _ := proto.Marshal(&pb.Telemetry{Variant: &pb.Telemetry_DeviceMetrics{DeviceMetrics: &pb.DeviceMetrics{BatteryLevel: &battery}}})
	f.store(at, from, gw, &pb.Data{Portnum: pb.PortNum_TELEMETRY_APP, Payload: b}, nil)
}

type apiClient struct {
	t   *testing.T
	srv *httptest.Server
	s   *api.Server
}

func newAPI(t *testing.T, pool *pgxpool.Pool, rc *cache.Client, now time.Time) *apiClient {
	env := config.Env{RetentionMonths: 6, DefaultWindowHours: 72, MaxWindowHours: 168, LiveQuantum: 10 * time.Second}
	s := &api.Server{Pool: pool, Env: env, ConfigRev: "it", Log: quiet,
		Now: func() time.Time { return now }}
	if rc != nil {
		s.DayCache = rc
	}
	mux := http.NewServeMux()
	s.NewHandler(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &apiClient{t: t, srv: srv, s: s}
}

func (c *apiClient) get(path string, q url.Values, out any) int {
	c.t.Helper()
	resp, err := http.Get(c.srv.URL + path + "?" + q.Encode())
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			c.t.Fatal(err)
		}
	}
	return resp.StatusCode
}

// obsRow is the part of an /observations row these tests read.
type obsRow struct {
	ID int64  `json:"i"`
	T  int64  `json:"t"`
	Y  string `json:"y"`
	S  uint32 `json:"s"`
	NK bool   `json:"nk"`
	NI *struct {
		LongName  string `json:"long_name"`
		ShortName string `json:"short_name"`
	} `json:"ni"`
	PO *struct {
		Lat           float64 `json:"lat"`
		PrecisionBits uint32  `json:"precision_bits"`
	} `json:"po"`
	MR *struct {
		Region      string `json:"region"`
		ModemPreset string `json:"modem_preset"`
	} `json:"mr"`
}

// rows fetches every page of a window from /observations.
func (c *apiClient) rows(q url.Values) ([]obsRow, int) {
	c.t.Helper()
	var all []obsRow
	q2 := url.Values{}
	for k, v := range q {
		q2[k] = v
	}
	for {
		var page struct {
			Rows       []obsRow `json:"rows"`
			More       bool     `json:"more"`
			NextCursor string   `json:"next_cursor"`
		}
		if code := c.get("/api/v1/observations", q2, &page); code != 200 {
			return nil, code
		}
		all = append(all, page.Rows...)
		if !page.More {
			return all, 200
		}
		q2.Set("cursor", page.NextCursor)
	}
}

// kinds lists "type:src" for each row, in order.
func kinds(rows []obsRow) []string {
	var out []string
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s:%x", r.Y, r.S))
	}
	return out
}

func win(start, end time.Time) url.Values {
	return url.Values{"start": {start.Format(time.RFC3339Nano)}, "end": {end.Format(time.RFC3339Nano)}}
}

const (
	nodeA = uint32(0x0a00000a)
	nodeB = uint32(0x0b00000b)
	gw1   = uint32(0x0c00000c)
)

var base = time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
var testNow = base.Add(24 * time.Hour)

// design §10.2 tests 11, 12, 13, 14 (as window end) and 17. The server's half of
// time isolation: /observations returns exactly the rows observed in
// [start, end). The views built from them are the engine's half
// (frontend/engine: views over Store::slice).
func TestTemporalIsolation(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	T1, T2, T3 := base.Add(1*time.Hour), base.Add(5*time.Hour), base.Add(9*time.Hour)
	f.nodeInfo(T1, nodeA, gw1, "OldName")
	f.position(T1, nodeA, gw1, 63.0)
	f.telemetry(T2, nodeA, gw1, 80)
	f.nodeInfo(T3, nodeA, gw1, "NewName")
	f.position(T3, nodeA, gw1, 64.0)
	c := newAPI(t, pool, rc, testNow)
	a := fmt.Sprintf("%x", nodeA)
	at := func(typs ...string) []string {
		var out []string
		for _, ty := range typs {
			out = append(out, ty+":"+a)
		}
		return out
	}
	cases := []struct {
		name string
		q    url.Values
		want []string
	}{
		{"only T2 (tests 11/12)", win(T2.Add(-time.Hour), T2.Add(time.Hour)), at("telemetry")},
		{"T1 not T3", win(T1.Add(-time.Hour), T2.Add(time.Hour)), at("nodeinfo", "position", "telemetry")},
		{"T3 not T1", win(T2.Add(-time.Hour), T3.Add(time.Hour)), at("telemetry", "nodeinfo", "position")},
		{"end before T3 hides the later rename (test 14)", win(T1.Add(-time.Hour), T3), at("nodeinfo", "position", "telemetry")},
		{"start exactly at T1 includes T1 (test 13)", win(T1, T1.Add(time.Hour)), at("nodeinfo", "position")},
		{"start 1ms after T1 excludes it (test 13)", win(T1.Add(time.Millisecond), T1.Add(2*time.Hour)), nil},
		{"end exactly at T1 excludes it (test 13)", win(T1.Add(-time.Hour), T1), nil},
	}
	for _, tc := range cases {
		rows, code := c.rows(tc.q)
		if code != 200 {
			t.Fatalf("%s: HTTP %d", tc.name, code)
		}
		if got := kinds(rows); !slices.Equal(got, tc.want) {
			t.Errorf("%s: rows %v, want %v", tc.name, got, tc.want)
		}
	}
	// Test 17: a fixed historic window does not change when later data arrives.
	q := win(T1.Add(-time.Hour), T2.Add(time.Hour))
	before, _ := c.rows(q)
	f.nodeInfo(T3.Add(time.Hour), nodeB, gw1, "Later")
	after, _ := c.rows(q)
	if !slices.Equal(kinds(before), kinds(after)) {
		t.Errorf("fixed window changed after later ingestion: %v -> %v", kinds(before), kinds(after))
	}
}

// design §10.2 test 15 (no stale results): with no server-side result cache, a row
// inserted inside a window is returned by the very next request, and
// other windows are unaffected.
func TestNoStaleResults(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	f.nodeInfo(base.Add(time.Hour), nodeA, gw1, "Alpha")
	c := newAPI(t, pool, rc, testNow)
	w1, w2 := win(base, base.Add(2*time.Hour)), win(base.Add(2*time.Hour), base.Add(4*time.Hour))
	if a, _ := c.rows(w1); len(a) != 1 {
		t.Fatalf("window 1: %v", kinds(a))
	}
	f.nodeInfo(base.Add(90*time.Minute), nodeA, gw1, "Beta")
	a, _ := c.rows(w1)
	b, _ := c.rows(w2)
	if len(a) != 2 || a[1].NI == nil || a[1].NI.LongName != "Beta" || len(b) != 0 {
		t.Fatalf("after insert: window 1 %v, window 2 %v", kinds(a), kinds(b))
	}
}

// design §10.2 test 16: the rolling window drops rows that aged out, with no new
// packets arriving.
func TestRollingWindowEviction(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	f.nodeInfo(base, nodeA, gw1, "Aging")
	q := url.Values{"duration": {"24h"}}
	in, _ := newAPI(t, pool, nil, base.Add(23*time.Hour)).rows(q)
	out, _ := newAPI(t, pool, nil, base.Add(24*time.Hour+time.Minute)).rows(q)
	if len(in) != 1 || len(out) != 0 {
		t.Fatalf("rolling eviction failed: before=%d after=%d", len(in), len(out))
	}
}

// design §10.2 test 18 through the API.
func TestRangeRejections(t *testing.T) {
	pool := freshDB(t)
	c := newAPI(t, pool, nil, testNow)
	for name, q := range map[string]url.Values{
		"7d+1s":         win(testNow.Add(-7*24*time.Hour-time.Second), testNow),
		"pre-retention": win(testNow.AddDate(0, -7, 0), testNow.AddDate(0, -7, 0).Add(time.Hour)),
		"future":        win(testNow.Add(-time.Hour), testNow.Add(time.Hour)),
		"reversed":      win(testNow, testNow.Add(-time.Hour)),
		"start-only":    {"start": {testNow.Add(-time.Hour).Format(time.RFC3339)}},
		"bad-timestamp": {"start": {"yesterday"}, "end": {"today"}},
		"bad-duration":  {"duration": {"8d"}},
	} {
		if code := c.get("/api/v1/observations", q, nil); code != 400 {
			t.Errorf("%s: HTTP %d, want 400", name, code)
		}
	}
}

// design §10.2 tests 19 and 20: rows deleted by retention are gone from the next
// response, and responses do not depend on Redis (a restart with an empty
// Redis returns identical rows).
func TestRetentionAndRebuild(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	cutoff := window.RetentionCutoff(now, 6)
	old := cutoff.Add(-time.Hour)
	f.nodeInfo(old, nodeA, gw1, "Expiring")
	f.nodeInfo(cutoff.Add(2*time.Hour), nodeB, gw1, "Staying")
	early := newAPI(t, pool, rc, now.Add(-2*time.Hour)) // cutoff 2 h earlier: the old row is selectable
	q := win(old.Add(-30*time.Minute), cutoff.Add(3*time.Hour))
	if rows, code := early.rows(q); code != 200 || len(rows) != 2 {
		t.Fatalf("precondition: HTTP %d, rows %v", code, kinds(rows))
	}
	r := &maintenance.Runner{Pool: pool, Cache: rc, Months: 6, Interval: 24 * time.Hour, Log: quiet, Now: func() time.Time { return now }}
	if st, err := r.RunOnce(context.Background()); err != nil || st.DeletedRows != 1 {
		t.Fatalf("retention: %+v %v", st, err)
	}
	if rows, _ := early.rows(q); len(rows) != 1 || rows[0].S != nodeB {
		t.Fatalf("deleted row reappeared: %v", kinds(rows))
	}
	_ = rc.R.FlushDB(context.Background()).Err()
	q2 := win(cutoff.Add(time.Hour), cutoff.Add(5*time.Hour))
	warm, _ := early.rows(q2)
	cold, _ := newAPI(t, pool, nil, now.Add(-2*time.Hour)).rows(q2)
	wj, _ := json.Marshal(warm)
	cj, _ := json.Marshal(cold)
	if string(wj) != string(cj) {
		t.Fatalf("rebuild differs:\nwarm %s\ncold %s", wj, cj)
	}
}

// Raw observations for client-side derivation (D-031): window isolation,
// since/until narrowing that never widens, and id paging.
func TestObservationsEndpoint(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	T1, T2, T3 := base.Add(1*time.Hour), base.Add(5*time.Hour), base.Add(9*time.Hour)
	f.nodeInfo(T1, nodeA, gw1, "OldName")
	f.position(T2, nodeA, gw1, 63.0)
	f.telemetry(T3, nodeA, gw1, 80)
	c := newAPI(t, pool, rc, testNow)

	type obs struct {
		Since time.Time
		Generation   string
		Rows         []struct {
			Tp string           `json:"tp"`
			ID int64            `json:"i"`
			T  int64            `json:"t"`
			Y  string           `json:"y"`
			NI *json.RawMessage `json:"ni"`
			PO *struct {
				Lat float64 `json:"lat"`
			} `json:"po"`
		}
		More       bool
		NextCursor string `json:"next_cursor"`
	}
	types := func(o obs) (out []string) {
		for _, r := range o.Rows {
			out = append(out, r.Y)
		}
		return out
	}
	var o obs
	if c.get("/api/v1/observations", win(base, base.Add(6*time.Hour)), &o) != 200 {
		t.Fatal("status")
	}
	if got := types(o); len(got) != 2 || got[0] != "nodeinfo" || got[1] != "position" || o.Generation == "" {
		t.Fatalf("window rows %v gen %q", got, o.Generation)
	}
	if o.Rows[0].NI == nil || o.Rows[1].PO == nil || o.Rows[1].PO.Lat != 63.0 {
		t.Fatal("decoded fields missing")
	}
	if o.Rows[0].Tp != "msh/EU_868" {
		t.Fatalf("topic root %q", o.Rows[0].Tp)
	}
	// since narrows; a since before the window start is clamped (never widens).
	q := win(base.Add(2*time.Hour), base.Add(10*time.Hour))
	q.Set("since", base.Add(-48*time.Hour).Format(time.RFC3339))
	c.get("/api/v1/observations", q, &o)
	if got := types(o); len(got) != 2 || got[0] != "position" || !o.Since.Equal(base.Add(2*time.Hour)) {
		t.Fatalf("clamped since: %v since %v", got, o.Since)
	}
	q.Set("since", base.Add(6*time.Hour).Format(time.RFC3339))
	q.Set("until", base.Add(30*time.Hour).Format(time.RFC3339))
	c.get("/api/v1/observations", q, &o)
	if got := types(o); len(got) != 1 || got[0] != "telemetry" {
		t.Fatalf("narrowed: %v", got)
	}
	// Paging in (observed_at, id) order with an opaque cursor.
	q = win(base, base.Add(12*time.Hour))
	q.Set("limit", "2")
	c.get("/api/v1/observations", q, &o)
	if got := types(o); len(got) != 2 || got[0] != "nodeinfo" || !o.More || o.NextCursor == "" {
		t.Fatalf("page 1: %v more=%v cursor=%q", got, o.More, o.NextCursor)
	}
	q.Set("cursor", o.NextCursor)
	c.get("/api/v1/observations", q, &o)
	if got := types(o); len(got) != 1 || got[0] != "telemetry" || o.More {
		t.Fatalf("page 2: %v more=%v", got, o.More)
	}
	q.Set("cursor", "not-a-cursor")
	if c.get("/api/v1/observations", q, nil) != 400 {
		t.Fatal("invalid cursor accepted")
	}
	// Window validation is the same as every other view.
	if c.get("/api/v1/observations", win(base.Add(-30*24*time.Hour*7), base), nil) != 400 {
		t.Fatal("expected 400 for a window beyond the maximum")
	}
}

func (f *fixture) insert(m ingest.RawMessage) error {
	obs, err := ingest.Process(m, ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4})
	if err != nil {
		return err
	}
	_, err = storage.InsertBatch(context.Background(), f.pool, []*ingest.Observation{&obs})
	return err
}

// D-032: map reports give positions like Position packets (latest wins);
// nodes that did not allow MQTT uplink are kept, flagged and unnamed.
func TestMapReportsAndMQTTOptOut(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	T1, T2 := base.Add(1*time.Hour), base.Add(2*time.Hour)
	f.position(T1, nodeA, gw1, 63.0)
	report, _ := proto.Marshal(&pb.MapReport{LongName: "A", LatitudeI: 640000000, LongitudeI: 104000000, PositionPrecision: 16,
		Region: pb.Config_LoRaConfig_EU_N_868, ModemPreset: pb.Config_LoRaConfig_NARROW_FAST})
	env, _ := proto.Marshal(&pb.ServiceEnvelope{ChannelId: "LongFast", GatewayId: protocol.NodeID(nodeA), Packet: &pb.MeshPacket{From: nodeA, To: protocol.Broadcast,
		PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_MAP_REPORT_APP, Payload: report}}}})
	if err := f.insert(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/map/", Payload: env, ObservedAt: T2}); err != nil {
		t.Fatal(err)
	}
	// nodeB: no OK-to-MQTT, uplinked by gw1. Its NodeInfo is kept without names (D-093), its position kept.
	notOK := uint32(0)
	b, _ := proto.Marshal(&pb.User{LongName: "Secret", ShortName: "SE"})
	f.pid++
	pt, _ := proto.Marshal(&pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b, Bitfield: &notOK})
	ct, _ := security.EncryptCTR(security.DefaultPSK[:], nodeB, f.pid, pt)
	mp := &pb.MeshPacket{From: nodeB, To: protocol.Broadcast, Id: f.pid, Channel: uint32(security.ChannelHash("LongFast", security.DefaultPSK[:], security.ModeCTR)),
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, HopStart: 3, HopLimit: 3}
	envB, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "LongFast", GatewayId: protocol.NodeID(gw1)})
	if err := f.insert(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/e/LongFast/" + protocol.NodeID(gw1), Payload: envB, ObservedAt: T1}); err != nil {
		t.Fatalf("nodeinfo: %v", err)
	}
	la, lo := int32(63.5e7), int32(10.4e7)
	pb2, _ := proto.Marshal(&pb.Position{LatitudeI: &la, LongitudeI: &lo, PrecisionBits: 32})
	f.store(T1, nodeB, gw1, &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: pb2, Bitfield: &notOK}, nil)

	var leaked int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM packet_log WHERE decoded_metadata::text LIKE '%Secret%' OR position('Secret'::bytea in envelope_bytes) > 0`).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("opt-out name stored: %d %v", leaked, err)
	}
	c := newAPI(t, pool, rc, testNow)
	rows, code := c.rows(win(base, base.Add(6*time.Hour)))
	if code != 200 {
		t.Fatalf("HTTP %d", code)
	}
	var reports, bPos, bInfo int
	for _, r := range rows {
		switch {
		case r.S == nodeA && r.Y == "mapreport":
			reports++
			if r.PO == nil || r.PO.Lat != 64.0 || r.PO.PrecisionBits != 16 {
				t.Fatalf("map report position: %+v", r.PO)
			}
			if r.MR == nil || r.MR.Region != "EU_N_868" || r.MR.ModemPreset != "NARROW_FAST" {
				t.Fatalf("map report radio: %+v", r.MR)
			}
		case r.S == nodeB && r.Y == "position":
			bPos++
			if !r.NK {
				t.Fatal("nodeB position should be marked not OK to MQTT")
			}
		case r.S == nodeB && r.Y == "nodeinfo":
			bInfo++
			if r.NI == nil || r.NI.LongName != "" || r.NI.ShortName != "" || !r.NK {
				t.Fatalf("nodeB NodeInfo must be unnamed and marked: %+v", r.NI)
			}
		}
	}
	if reports != 1 || bPos != 1 || bInfo != 1 {
		t.Fatalf("map reports %d, nodeB positions %d, nodeB NodeInfo %d (want 1, 1, 1)", reports, bPos, bInfo)
	}
}

// D-033: the row streamed live equals the row /observations returns after
// the database round trip, for every packet type the views read.
func TestLiveRowMatchesStoredRow(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	T1 := base.Add(time.Hour)
	f.nodeInfo(T1, nodeA, gw1, "Alpha")
	f.position(T1.Add(time.Minute), nodeA, gw1, 63.25)
	f.telemetry(T1.Add(2*time.Minute), nodeA, gw1, 77)
	nb, _ := proto.Marshal(&pb.NeighborInfo{NodeId: nodeB, Neighbors: []*pb.Neighbor{{NodeId: nodeA, Snr: 6.25}}})
	f.store(T1.Add(3*time.Minute), nodeB, gw1, &pb.Data{Portnum: pb.PortNum_NEIGHBORINFO_APP, Payload: nb}, nil)

	// Rebuild each observation exactly as the pipeline does and compare.
	rows, err := pool.Query(context.Background(), `SELECT id, observed_at, envelope_bytes, mqtt_topic FROM packet_log ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	live := map[int64]string{}
	for rows.Next() {
		var id int64
		var at time.Time
		var env []byte
		var topic string
		if err := rows.Scan(&id, &at, &env, &topic); err != nil {
			t.Fatal(err)
		}
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "it", Topic: topic, Payload: env, ObservedAt: at},
			ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4})
		if err != nil {
			t.Fatal(err)
		}
		b, err := ingest.LiveRow(&obs, id)
		if err != nil {
			t.Fatal(err)
		}
		live[id] = string(b)
	}
	rows.Close()
	var o struct {
		Rows []json.RawMessage `json:"rows"`
	}
	c := newAPI(t, pool, rc, testNow)
	c.get("/api/v1/observations", win(base, base.Add(6*time.Hour)), &o)
	if len(o.Rows) != 4 {
		t.Fatalf("rows: %d", len(o.Rows))
	}
	for _, raw := range o.Rows {
		var r struct {
			ID int64 `json:"i"`
		}
		_ = json.Unmarshal(raw, &r)
		var a, b any
		_ = json.Unmarshal(raw, &a)
		_ = json.Unmarshal([]byte(live[r.ID]), &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("row %d differs:\nstored %s\nlive   %s", r.ID, raw, live[r.ID])
		}
	}
}

// D-046: rows whose stored encoding is missing or of another version are
// served the same from their columns, and the backfill restores them.
func TestStoredRowEncodings(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	T1 := base.Add(time.Hour)
	f.nodeInfo(T1, nodeA, gw1, "Alpha")
	f.position(T1.Add(time.Minute), nodeA, gw1, 63.25)
	f.telemetry(T1.Add(2*time.Minute), nodeA, gw1, 77)
	ctx := context.Background()
	if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE obs_row IS NOT NULL AND obs_row_version = $1`, int16(obsrow.Version)); n != 3 {
		t.Fatalf("rows stored with their encoding: %d of 3", n)
	}
	c := newAPI(t, pool, rc, testNow)
	page := func() string {
		var o struct {
			Rows json.RawMessage `json:"rows"`
		}
		c.get("/api/v1/observations", win(base, base.Add(6*time.Hour)), &o)
		return string(o.Rows)
	}
	want := page()
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET obs_row = NULL, obs_row_version = NULL WHERE packet_type = 'nodeinfo'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET obs_row = '"stale"}', obs_row_version = $1 WHERE packet_type = 'position'`, int16(obsrow.Version-1)); err != nil {
		t.Fatal(err)
	}
	if got := page(); got != want {
		t.Fatalf("rows without a current encoding differ:\ngot  %s\nwant %s", got, want)
	}
	n, err := storage.BackfillObsRows(ctx, pool, slog.Default())
	if err != nil || n != 2 {
		t.Fatalf("backfill: %d rows, %v (want 2)", n, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE obs_row_version = $1`, int16(obsrow.Version)); n != 3 {
		t.Fatalf("current encodings after backfill: %d of 3", n)
	}
	if got := page(); got != want {
		t.Fatalf("rows after backfill differ:\ngot  %s\nwant %s", got, want)
	}
}

// D-104: daily and monthly trends over the whole retained log, in the
// requested time zone; new nodes count once, in the bucket they first appear.
func TestTrends(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	day1, day2 := base.Add(10*time.Hour), base.Add(34*time.Hour)
	f.position(day1, nodeA, gw1, 63.0)
	f.position(day1.Add(time.Hour), nodeA, gw1, 63.0)
	f.position(day2, nodeA, gw1, 63.0)
	f.position(day2, nodeB, gw1, 63.1)
	// 23:30 UTC on day 2 is already day 3 in Oslo.
	f.position(base.Add(47*time.Hour+30*time.Minute), nodeB, gw1, 63.1)
	c := newAPI(t, pool, rc, testNow)
	var got struct {
		Buckets []struct {
			Start                                time.Time
			Nodes, Gateways, Packets, Receptions int
			NewNodes                             int            `json:"new_nodes"`
			ByType                               map[string]int `json:"by_type"`
		} `json:"buckets"`
	}
	if code := c.get("/api/v1/trends", url.Values{"bucket": {"day"}, "tz": {"Europe/Oslo"}}, &got); code != 200 {
		t.Fatalf("HTTP %d", code)
	}
	if len(got.Buckets) != 3 {
		t.Fatalf("%d day buckets, want 3: %+v", len(got.Buckets), got.Buckets)
	}
	b := got.Buckets
	if b[0].Nodes != 1 || b[0].Packets != 2 || b[0].NewNodes != 1 || b[0].ByType["position"] != 2 || b[0].Gateways != 1 {
		t.Fatalf("day 1: %+v", b[0])
	}
	if b[1].Nodes != 2 || b[1].NewNodes != 1 || b[2].Nodes != 1 || b[2].NewNodes != 0 {
		t.Fatalf("days 2-3: %+v %+v", b[1], b[2])
	}
	if b[2].Start.UTC().Hour() != 23 {
		t.Fatalf("day 3 should start at Oslo midnight (23:00 UTC): %v", b[2].Start)
	}
	// The last packet is already November in Oslo: October and November.
	if code := c.get("/api/v1/trends", url.Values{"bucket": {"month"}, "tz": {"Europe/Oslo"}}, &got); code != 200 || len(got.Buckets) != 2 || got.Buckets[0].Nodes != 2 || got.Buckets[0].NewNodes != 2 || got.Buckets[1].Nodes != 1 || got.Buckets[1].NewNodes != 0 {
		t.Fatalf("month: %d %+v", code, got.Buckets)
	}
	if code := c.get("/api/v1/trends", url.Values{"tz": {"Mars/Olympus"}}, &got); code != 400 {
		t.Fatalf("bad zone: HTTP %d", code)
	}
}

// D-107: rows decoded by an older decoder are decoded again from their
// envelopes; rows the decoder would now reject are kept, only marked.
func TestRedecodeOldRows(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	st, _ := proto.Marshal(&pb.StatusMessage{Status: "On the hill"})
	f.store(base.Add(time.Hour), nodeA, gw1, &pb.Data{Portnum: pb.PortNum_NODE_STATUS_APP, Payload: st}, nil)
	f.position(base.Add(2*time.Hour), nodeB, gw1, 63.0)
	ctx := context.Background()
	// As the previous decoder stored them: node status as "other", without its text;
	// and a row whose envelope no longer parses.
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET packet_type = 'other', decoded_metadata = '{"other": {"port_name": "NODE_STATUS_APP"}}', decode_version = 2,
		obs_row = 'stale', obs_row_version = 6 WHERE source_node_id = $1`, int64(nodeA)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET envelope_bytes = '\xffff'::bytea, decode_version = 1 WHERE source_node_id = $1`, int64(nodeB)); err != nil {
		t.Fatal(err)
	}
	n, err := storage.Redecode(ctx, pool, ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4}, quiet)
	if err != nil || n != 1 {
		t.Fatalf("redecode: %d %v", n, err)
	}
	var ty, status string
	var dv int
	var obsRow *string
	if err := pool.QueryRow(ctx, `SELECT packet_type, decoded_metadata->'node_status'->>'status', decode_version, obs_row FROM packet_log WHERE source_node_id = $1`, int64(nodeA)).Scan(&ty, &status, &dv, &obsRow); err != nil {
		t.Fatal(err)
	}
	if ty != "node_status" || status != "On the hill" || dv != ingest.DecodeVersion || obsRow != nil {
		t.Fatalf("re-decoded row: %s %q v%d obs_row %v", ty, status, dv, obsRow)
	}
	if err := pool.QueryRow(ctx, `SELECT packet_type, decode_version FROM packet_log WHERE source_node_id = $1`, int64(nodeB)).Scan(&ty, &dv); err != nil || ty != "position" || dv != ingest.DecodeVersion {
		t.Fatalf("unparseable row should be kept as it was, marked checked: %s v%d %v", ty, dv, err)
	}
	// A second run finds nothing to do.
	if n, err := storage.Redecode(ctx, pool, ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4}, quiet); err != nil || n != 0 {
		t.Fatalf("second run: %d %v", n, err)
	}
}

// D-112: trends come from hourly summaries in memory, refreshed
// incrementally; hours summed under an older decoder are recomputed, and
// hours older than the retained log are dropped.
func TestTrendSummaries(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	ctx := context.Background()
	f.position(base.Add(time.Hour), nodeA, gw1, 63.0)
	f.position(base.Add(26*time.Hour), nodeB, gw1, 63.1)
	var th storage.TrendHours
	now := base.Add(27 * time.Hour)
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if th.Len() != 2 {
		t.Fatalf("%d summarised hours, want 2", th.Len())
	}
	// A new row in a recent hour is picked up by the next refresh.
	f.position(base.Add(26*time.Hour+30*time.Minute), nodeA, gw1, 63.0)
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if h, _ := th.Hour(base.Add(26 * time.Hour)); len(h.Nodes) != 2 || h.Packets != 2 {
		t.Fatalf("recent hour: %+v", h)
	}
	// Hours before the oldest retained row go when it does.
	if _, err := pool.Exec(ctx, `DELETE FROM packet_log WHERE observed_at < $1`, base.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if _, ok := th.Hour(base.Add(time.Hour)); ok || th.Len() != 1 {
		t.Fatalf("an hour outlived the data (%d left)", th.Len())
	}
	// Older history stored later (an import) is summed by the next refresh.
	f.position(base.Add(-48*time.Hour+10*time.Minute), nodeB, gw1, 63.1)
	if err := th.Refresh(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if h, ok := th.Hour(base.Add(-48 * time.Hour)); !ok || h.Packets != 1 || th.Len() != 2 {
		t.Fatalf("imported hour: %+v %v (%d hours)", h, ok, th.Len())
	}
	if tables, _ := storage.ApplicationTables(ctx, pool); !slices.Equal(tables, storage.Tables) {
		t.Fatalf("trends must not add tables: %v", tables)
	}
}

// D-107: rows whose envelope was stripped at ingest (header-only, invalid,
// opt-out NodeInfo) come through a re-decode unchanged: decoding a zeroed
// payload again could only lose what was kept, or turn an invalid row,
// whose sender may be forged, into evidence.
func TestRedecodeLeavesStrippedRowsAlone(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	ctx := context.Background()
	o := ingest.Options{Keyring: f.kr, Identities: fixtureIDs(f.ids), KeyBudget: 4}
	gw := protocol.NodeID(gw1)
	store := func(topic string, mp *pb.MeshPacket, channel string) {
		t.Helper()
		env, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: channel, GatewayId: gw})
		obs, err := ingest.Process(ingest.RawMessage{BrokerID: "it", Topic: topic, Payload: env, ObservedAt: base.Add(time.Hour)}, o)
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		if _, err := storage.InsertBatch(ctx, pool, []*ingest.Observation{&obs}); err != nil {
			t.Fatal(err)
		}
	}
	// An end-to-end encrypted DM; a channel without our key; an unencrypted
	// uplink from a broker not trusted for plaintext (invalid).
	store("msh/EU_868/2/e/PKI/"+gw, &pb.MeshPacket{From: nodeA, To: nodeB, Id: 7001, PkiEncrypted: true, PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: make([]byte, 40)}}, "PKI")
	secret := make([]byte, 32)
	secret[0] = 9
	ct, _ := security.EncryptCTR(secret, nodeA, 7002, []byte{8, 1, 18, 2, 'h', 'i'})
	store("msh/EU_868/2/e/Private/"+gw, &pb.MeshPacket{From: nodeA, To: protocol.Broadcast, Id: 7002, Channel: uint32(security.ChannelHash("Private", secret, security.ModeCTR)), PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, HopStart: 3, HopLimit: 3}, "Private")
	store("msh/EU_868/2/e/LongFast/"+gw, &pb.MeshPacket{From: nodeA, To: protocol.Broadcast, Id: 7003, PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("hi")}}}, "LongFast")
	// A NodeInfo from a node that did not allow MQTT, uplinked by another gateway.
	notOK := uint32(0)
	ub, _ := proto.Marshal(&pb.User{LongName: "Secret", ShortName: "SE", HwModel: pb.HardwareModel_RAK4631})
	pt, _ := proto.Marshal(&pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: ub, Bitfield: &notOK})
	ct2, _ := security.EncryptCTR(security.DefaultPSK[:], nodeB, 7004, pt)
	store("msh/EU_868/2/e/LongFast/"+gw, &pb.MeshPacket{From: nodeB, To: protocol.Broadcast, Id: 7004, Channel: uint32(security.ChannelHash("LongFast", security.DefaultPSK[:], security.ModeCTR)), PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct2}, HopStart: 3, HopLimit: 3}, "LongFast")

	type row struct{ Type, Meta string }
	read := func() map[int64]row {
		out := map[int64]row{}
		rs, err := pool.Query(ctx, `SELECT packet_id, packet_type, decoded_metadata::text FROM packet_log ORDER BY packet_id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		for rs.Next() {
			var id int64
			var r row
			if err := rs.Scan(&id, &r.Type, &r.Meta); err != nil {
				t.Fatal(err)
			}
			out[id] = r
		}
		return out
	}
	before := read()
	want := map[int64]string{7001: "direct_message", 7002: "encrypted", 7003: "invalid", 7004: "nodeinfo"}
	for id, ty := range want {
		if before[id].Type != ty {
			t.Fatalf("packet %d stored as %q, want %q", id, before[id].Type, ty)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = 2`); err != nil {
		t.Fatal(err)
	}
	if n, err := storage.Redecode(ctx, pool, o, quiet); err != nil || n != 0 {
		t.Fatalf("redecode changed %d stripped rows (%v)", n, err)
	}
	after := read()
	for id := range want {
		if after[id] != before[id] {
			t.Fatalf("packet %d changed: %+v -> %+v", id, before[id], after[id])
		}
	}
	if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE decode_version <> $1`, ingest.DecodeVersion); n != 0 {
		t.Fatalf("%d stripped rows not marked as checked", n)
	}
}

// D-166: a fully decoded row that today's keys, policy or identities would
// read less of keeps its decoding; decoder improvements are still applied.
func TestRedecodeNeverDowngrades(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	ctx := context.Background()
	// A signed position from a node whose key is known: verified.
	k := testutil.NewXKey(1)
	signer := k.NodeNum()
	id, err := security.NewIdentity(signer, k.X25519Pub)
	if err != nil {
		t.Fatal(err)
	}
	f.ids[signer] = id
	la, lo := int32(63.0*1e7), int32(10.4*1e7)
	pos, _ := proto.Marshal(&pb.Position{LatitudeI: &la, LongitudeI: &lo, PrecisionBits: 32})
	f.store(base.Add(time.Hour), signer, gw1, &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: pos}, &k)
	// A text on a private channel whose key was configured then.
	secret := make([]byte, 32)
	secret[0] = 9
	withPrivate, err := security.NewKeyring([]security.ChannelConfig{{Name: "LongFast", PSKs: []string{"AQ=="}}, {Name: "Private", PSKs: []string{base64.StdEncoding.EncodeToString(secret)}}})
	if err != nil {
		t.Fatal(err)
	}
	gw := protocol.NodeID(gw1)
	ct, _ := security.EncryptCTR(secret, nodeA, 7002, []byte{8, 1, 18, 2, 'h', 'i'})
	env, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: &pb.MeshPacket{From: nodeA, To: protocol.Broadcast, Id: 7002, Channel: uint32(security.ChannelHash("Private", secret, security.ModeCTR)),
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, HopStart: 3, HopLimit: 3}, ChannelId: "Private", GatewayId: gw})
	obs, err := ingest.Process(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/e/Private/" + gw, Payload: env, ObservedAt: base.Add(time.Hour)},
		ingest.Options{Keyring: withPrivate, Identities: fixtureIDs(f.ids), KeyBudget: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.InsertBatch(ctx, pool, []*ingest.Observation{&obs}); err != nil {
		t.Fatal(err)
	}
	// A node status the previous decoder stored as "other": an improvement.
	st, _ := proto.Marshal(&pb.StatusMessage{Status: "On the hill"})
	f.store(base.Add(2*time.Hour), nodeB, gw1, &pb.Data{Portnum: pb.PortNum_NODE_STATUS_APP, Payload: st}, nil)

	type row struct {
		Type, Sig, Meta string
		Env             []byte
	}
	read := func(q string, args ...any) row {
		t.Helper()
		var r row
		if err := pool.QueryRow(ctx, `SELECT packet_type, signature_status, decoded_metadata::text, envelope_bytes FROM packet_log WHERE `+q, args...).Scan(&r.Type, &r.Sig, &r.Meta, &r.Env); err != nil {
			t.Fatal(err)
		}
		return r
	}
	signed, private := read(`source_node_id = $1`, int64(signer)), read(`packet_id = 7002`)
	if signed.Type != "position" || signed.Sig != "verified" || private.Type == "encrypted" || private.Type == "invalid" {
		t.Fatalf("stored as %+v / %+v", signed, private)
	}
	// The private key is removed and the signer's key aged out; then the
	// policy also turns strict. Neither run may lose what the rows hold.
	for _, policy := range []security.Policy{security.PolicyBalanced, security.PolicyStrict} {
		if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = 2`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE packet_log SET packet_type = 'other', decoded_metadata = '{"other": {"port_name": "NODE_STATUS_APP"}}' WHERE source_node_id = $1`, int64(nodeB)); err != nil {
			t.Fatal(err)
		}
		o := ingest.Options{Keyring: f.kr, Identities: fixtureIDs{}, Policy: policy, KeyBudget: 4}
		if n, err := storage.Redecode(ctx, pool, o, quiet); err != nil || n != 1 {
			t.Fatalf("policy %d: redecode changed %d rows (%v), want only the improved one", policy, n, err)
		}
		if got := read(`source_node_id = $1`, int64(signer)); !reflect.DeepEqual(got, signed) {
			t.Fatalf("policy %d: signed row downgraded: %+v -> %+v", policy, signed, got)
		}
		if got := read(`packet_id = 7002`); !reflect.DeepEqual(got, private) {
			t.Fatalf("policy %d: private row downgraded: %+v -> %+v", policy, private, got)
		}
		if got := read(`source_node_id = $1`, int64(nodeB)); got.Type != "node_status" {
			t.Fatalf("policy %d: improvement not applied: %+v", policy, got)
		}
		if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE decode_version <> $1`, ingest.DecodeVersion); n != 0 {
			t.Fatalf("policy %d: %d rows not marked as checked", policy, n)
		}
	}
}
