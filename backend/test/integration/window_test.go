//go:build integration

package integration

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
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
	if _, err := storage.InsertBatch(context.Background(), f.pool, []*ingest.Observation{&obs}); err != nil {
		f.t.Fatal(err)
	}
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
	s := &api.Server{Pool: pool, Results: cache.NewResults(rc, nil), Env: env, ConfigRev: "it", Log: quiet,
		Now: func() time.Time { return now }}
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
	if out != nil && resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			c.t.Fatal(err)
		}
	}
	return resp.StatusCode
}

type snapResp struct {
	Meta struct {
		Revision string `json:"revision"`
	} `json:"meta"`
	Nodes []struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Identity *struct {
			LongName string `json:"long_name"`
		} `json:"identity"`
		Position *struct {
			Lat float64 `json:"lat"`
		} `json:"position"`
		Telemetry *struct {
			Battery *float64 `json:"battery"`
		} `json:"telemetry"`
		Packets int `json:"packets"`
	} `json:"nodes"`
	Counts struct {
		Packets    int `json:"packets"`
		Receptions int `json:"receptions"`
	} `json:"counts"`
}

func win(start, end time.Time) url.Values {
	return url.Values{"start": {start.Format(time.RFC3339Nano)}, "end": {end.Format(time.RFC3339Nano)}}
}

func (s snapResp) node(id uint32) *struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Identity *struct {
		LongName string `json:"long_name"`
	} `json:"identity"`
	Position *struct {
		Lat float64 `json:"lat"`
	} `json:"position"`
	Telemetry *struct {
		Battery *float64 `json:"battery"`
	} `json:"telemetry"`
	Packets int `json:"packets"`
} {
	for i := range s.Nodes {
		if s.Nodes[i].ID == protocol.NodeID(id) {
			return &s.Nodes[i]
		}
	}
	return nil
}

const (
	nodeA = uint32(0x0a00000a)
	nodeB = uint32(0x0b00000b)
	gw1   = uint32(0x0c00000c)
)

var base = time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
var testNow = base.Add(24 * time.Hour)

// §17 tests 11, 12, 13, 14 (as window end) and 17.
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

	cases := []struct {
		name      string
		q         url.Values
		wantName  string // "" = no identity
		wantLat   float64
		wantFound bool
	}{
		{"only T2: neither name, no position (test 11/12)", win(T2.Add(-time.Hour), T2.Add(time.Hour)), "", 0, true},
		{"T1 not T3: OldName", win(T1.Add(-time.Hour), T2.Add(time.Hour)), "OldName", 63.0, true},
		{"T3 not T1: NewName", win(T2.Add(-time.Hour), T3.Add(time.Hour)), "NewName", 64.0, true},
		{"both: latest in window", win(T1.Add(-time.Hour), T3.Add(time.Hour)), "NewName", 64.0, true},
		{"end before T3 hides later rename (test 14)", win(T1.Add(-time.Hour), T3), "OldName", 63.0, true},
		{"start exactly at T1 includes T1 (test 13)", win(T1, T1.Add(time.Hour)), "OldName", 63.0, true},
		{"start 1ms after T1 excludes it (test 13)", win(T1.Add(time.Millisecond), T1.Add(2*time.Hour)), "", 0, false},
		{"end exactly at T1 excludes it (test 13)", win(T1.Add(-time.Hour), T1), "", 0, false},
	}
	for _, tc := range cases {
		var s snapResp
		if code := c.get("/api/v1/snapshot", tc.q, &s); code != 200 {
			t.Fatalf("%s: HTTP %d", tc.name, code)
		}
		n := s.node(nodeA)
		if (n != nil) != tc.wantFound {
			t.Errorf("%s: node present=%v, want %v", tc.name, n != nil, tc.wantFound)
			continue
		}
		if n == nil {
			continue
		}
		got := ""
		if n.Identity != nil {
			got = n.Identity.LongName
		}
		if got != tc.wantName {
			t.Errorf("%s: name %q, want %q", tc.name, got, tc.wantName)
		}
		if (n.Position == nil) != (tc.wantLat == 0) || (n.Position != nil && n.Position.Lat != tc.wantLat) {
			t.Errorf("%s: position %+v, want lat %v", tc.name, n.Position, tc.wantLat)
		}
	}

	// Node detail obeys the same window.
	var d struct {
		Identity *struct {
			LongName string `json:"long_name"`
		} `json:"identity"`
		Positions []any `json:"positions"`
	}
	if code := c.get("/api/v1/nodes/"+url.PathEscape(protocol.NodeID(nodeA)), win(T2.Add(-time.Hour), T2.Add(time.Hour)), &d); code != 200 {
		t.Fatalf("node detail HTTP %d", code)
	}
	if d.Identity != nil || len(d.Positions) != 0 {
		t.Errorf("node detail leaked out-of-window identity/positions: %+v", d)
	}
	if code := c.get("/api/v1/nodes/"+url.PathEscape(protocol.NodeID(nodeB)), win(T1, T3), nil); code != 404 {
		t.Errorf("absent node: HTTP %d, want 404", code)
	}

	// Test 17: a fixed historic window does not change when later data arrives.
	var before, after snapResp
	q := win(T1.Add(-time.Hour), T2.Add(time.Hour))
	c.get("/api/v1/snapshot", q, &before)
	f.nodeInfo(T3.Add(time.Hour), nodeB, gw1, "Later")
	c.get("/api/v1/snapshot", q, &after)
	if before.Meta.Revision != after.Meta.Revision || len(before.Nodes) != len(after.Nodes) || after.node(nodeB) != nil {
		t.Errorf("fixed window changed after later ingestion")
	}
}

// §17 test 15: cached results are scoped by window and revision; new
// in-window data yields a new revision rather than a stale hit.
func TestCacheScoping(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	f.nodeInfo(base.Add(time.Hour), nodeA, gw1, "Alpha")
	c := newAPI(t, pool, rc, testNow)
	w1 := win(base, base.Add(2*time.Hour))
	w2 := win(base.Add(2*time.Hour), base.Add(4*time.Hour))
	var a, b, a2 snapResp
	c.get("/api/v1/snapshot", w1, &a)
	c.get("/api/v1/snapshot", w2, &b)
	if a.node(nodeA) == nil || b.node(nodeA) != nil {
		t.Fatal("windows not isolated")
	}
	f.nodeInfo(base.Add(90*time.Minute), nodeA, gw1, "Beta")
	c.get("/api/v1/snapshot", w1, &a2)
	if a2.Meta.Revision == a.Meta.Revision || a2.node(nodeA).Identity.LongName != "Beta" {
		t.Fatalf("stale cache served after in-window insert: rev %s -> %s, name %s", a.Meta.Revision, a2.Meta.Revision, a2.node(nodeA).Identity.LongName)
	}
	keys, _ := rc.R.Keys(context.Background(), "meshmap:res:*").Result()
	if len(keys) < 3 {
		t.Fatalf("expected separate cache entries per window/revision, got %d", len(keys))
	}
}

// §17 test 16: the rolling window ejects evidence that aged out, with no
// new packets arriving.
func TestRollingWindowEviction(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	f.nodeInfo(base, nodeA, gw1, "Aging")
	q := url.Values{"duration": {"24h"}}
	var in, out snapResp
	newAPI(t, pool, nil, base.Add(23*time.Hour)).get("/api/v1/snapshot", q, &in)
	newAPI(t, pool, nil, base.Add(24*time.Hour+time.Minute)).get("/api/v1/snapshot", q, &out)
	if in.node(nodeA) == nil || out.node(nodeA) != nil {
		t.Fatalf("rolling eviction failed: before=%v after=%v", in.node(nodeA) != nil, out.node(nodeA) != nil)
	}
}

// §17 test 18 through the API.
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
		if code := c.get("/api/v1/snapshot", q, nil); code != 400 {
			t.Errorf("%s: HTTP %d, want 400", name, code)
		}
	}
}

// §17 tests 19 and 20: retention deletion invalidates cached results, and a
// restart with an empty Redis reconstructs identical results.
func TestRetentionInvalidationAndRebuild(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	cutoff := window.RetentionCutoff(now, 6)
	old := cutoff.Add(-time.Hour)
	f.nodeInfo(old, nodeA, gw1, "Expiring")
	f.nodeInfo(cutoff.Add(2*time.Hour), nodeB, gw1, "Staying")
	// Window starts after the cutoff at query time but includes the old row
	// only while it is retained: use a window ending just after the cutoff
	// queried "before" retention runs (clock earlier), then after.
	early := newAPI(t, pool, rc, now.Add(-2*time.Hour)) // cutoff 2 h earlier: old row selectable
	q := win(old.Add(-30*time.Minute), cutoff.Add(3*time.Hour))
	var s1 snapResp
	if code := early.get("/api/v1/snapshot", q, &s1); code != 200 || s1.node(nodeA) == nil {
		t.Fatalf("precondition: HTTP %d, expiring node present=%v", code, s1.node(nodeA) != nil)
	}
	r := &maintenance.Runner{Pool: pool, Cache: rc, Months: 6, Interval: 24 * time.Hour, Log: quiet, Now: func() time.Time { return now }}
	if st, err := r.RunOnce(context.Background()); err != nil || st.DeletedRows != 1 {
		t.Fatalf("retention: %+v %v", st, err)
	}
	var s2 snapResp
	early.get("/api/v1/snapshot", q, &s2)
	if s2.node(nodeA) != nil || s2.Meta.Revision == s1.Meta.Revision {
		t.Fatal("deleted evidence reappeared from cache")
	}

	// Restart: fresh server, Redis wiped -> identical JSON.
	q2 := win(cutoff.Add(time.Hour), cutoff.Add(5*time.Hour))
	var warm, cold json.RawMessage
	early.get("/api/v1/snapshot", q2, &warm)
	_ = rc.R.FlushDB(context.Background()).Err()
	newAPI(t, pool, nil, now.Add(-2*time.Hour)).get("/api/v1/snapshot", q2, &cold)
	if stripVolatile(t, warm) != stripVolatile(t, cold) {
		t.Fatalf("rebuild differs:\nwarm %s\ncold %s", warm, cold)
	}
}

// stripVolatile removes generation time and the cache generation part of
// the revision (Redis-held retention counter resets when Redis is wiped).
func stripVolatile(t *testing.T, raw json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	meta := m["meta"].(map[string]any)
	delete(meta, "generated_at")
	delete(meta, "revision")
	delete(m, "$schema") // contains the (test) server address
	b, _ := json.Marshal(m)
	return string(b)
}

// Deploys flush computed results (cache keys do not encode code versions);
// dedupe keys survive.
func TestResultCacheFlush(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	f := newFixture(t, pool)
	f.nodeInfo(base.Add(time.Hour), nodeA, gw1, "Alpha")
	c := newAPI(t, pool, rc, testNow)
	c.get("/api/v1/snapshot", win(base, base.Add(2*time.Hour)), nil)
	ctx := context.Background()
	rc.R.Set(ctx, "meshmap:obs:keep", "1", 0)
	n, err := cache.NewResults(rc, nil).Flush(ctx)
	if err != nil || n == 0 {
		t.Fatalf("flush: n=%d err=%v", n, err)
	}
	if keys, _ := rc.R.Keys(ctx, cache.ResultKeyPrefix+"*").Result(); len(keys) != 0 {
		t.Fatalf("results left: %v", keys)
	}
	if v, _ := rc.R.Get(ctx, "meshmap:obs:keep").Result(); v != "1" {
		t.Fatal("dedupe key removed")
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
		Since, Until time.Time
		Generation   string
		Rows         []struct {
			ID int64            `json:"i"`
			T  int64            `json:"t"`
			Y  string           `json:"y"`
			NI *json.RawMessage `json:"ni"`
			PO *struct {
				Lat float64 `json:"lat"`
			} `json:"po"`
		}
		More      bool
		NextAfter int64 `json:"next_after"`
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
	if got := types(o); len(got) != 1 || got[0] != "telemetry" || !o.Until.Equal(base.Add(10*time.Hour)) {
		t.Fatalf("narrowed: %v until %v", got, o.Until)
	}
	// Paging by id.
	q = win(base, base.Add(12*time.Hour))
	q.Set("limit", "2")
	c.get("/api/v1/observations", q, &o)
	if len(o.Rows) != 2 || !o.More {
		t.Fatalf("page 1: %d more=%v", len(o.Rows), o.More)
	}
	q.Set("after", fmt.Sprint(o.NextAfter))
	c.get("/api/v1/observations", q, &o)
	if got := types(o); len(got) != 1 || got[0] != "telemetry" || o.More {
		t.Fatalf("page 2: %v more=%v", got, o.More)
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
	report, _ := proto.Marshal(&pb.MapReport{LongName: "A", LatitudeI: 640000000, LongitudeI: 104000000, PositionPrecision: 16})
	env, _ := proto.Marshal(&pb.ServiceEnvelope{ChannelId: "LongFast", GatewayId: protocol.NodeID(nodeA), Packet: &pb.MeshPacket{From: nodeA, To: protocol.Broadcast,
		PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_MAP_REPORT_APP, Payload: report}}}})
	if err := f.insert(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/map/", Payload: env, ObservedAt: T2}); err != nil {
		t.Fatal(err)
	}
	// nodeB: no OK-to-MQTT, uplinked by gw1. Its NodeInfo is refused, its position kept.
	notOK := uint32(0)
	b, _ := proto.Marshal(&pb.User{LongName: "Secret", ShortName: "SE"})
	f.pid++
	pt, _ := proto.Marshal(&pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b, Bitfield: &notOK})
	ct, _ := security.EncryptCTR(security.DefaultPSK[:], nodeB, f.pid, pt)
	mp := &pb.MeshPacket{From: nodeB, To: protocol.Broadcast, Id: f.pid, Channel: uint32(security.ChannelHash("LongFast", security.DefaultPSK[:], security.ModeCTR)),
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, HopStart: 3, HopLimit: 3}
	envB, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "LongFast", GatewayId: protocol.NodeID(gw1)})
	if err := f.insert(ingest.RawMessage{BrokerID: "it", Topic: "msh/EU_868/2/e/LongFast/" + protocol.NodeID(gw1), Payload: envB, ObservedAt: T1}); ingest.Category(err) != "not_ok_to_mqtt_nodeinfo" {
		t.Fatalf("nodeinfo: %v", err)
	}
	la, lo := int32(63.5e7), int32(10.4e7)
	pb2, _ := proto.Marshal(&pb.Position{LatitudeI: &la, LongitudeI: &lo, PrecisionBits: 32})
	f.store(T1, nodeB, gw1, &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: pb2, Bitfield: &notOK}, nil)

	c := newAPI(t, pool, rc, testNow)
	var s struct {
		Nodes []struct {
			ID         string    `json:"id"`
			MQTTOptOut bool      `json:"mqtt_opt_out"`
			Identity   *struct{} `json:"identity"`
			Position   *struct {
				Lat           float64 `json:"lat"`
				PrecisionBits uint32  `json:"precision_bits"`
			} `json:"position"`
		} `json:"nodes"`
	}
	if c.get("/api/v1/snapshot", win(base, base.Add(6*time.Hour)), &s) != 200 {
		t.Fatal("status")
	}
	seen := 0
	for _, n := range s.Nodes {
		switch n.ID {
		case protocol.NodeID(nodeA):
			seen++
			if n.Position == nil || n.Position.Lat != 64.0 || n.Position.PrecisionBits != 16 || n.MQTTOptOut {
				t.Fatalf("nodeA: map report should be the latest position: %+v", n)
			}
		case protocol.NodeID(nodeB):
			seen++
			if !n.MQTTOptOut || n.Identity != nil || n.Position == nil {
				t.Fatalf("nodeB: %+v", n)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("nodes missing: %+v", s.Nodes)
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
		b, _ := json.Marshal(ingest.LiveRow(&obs, id))
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
