//go:build integration

// Integration tests against real PostgreSQL, Redis and Mosquitto, started by
// scripts/integration.sh. They cover design §10.2 tests 9, 10, 20 (identity part),
// 33 and parts of 35.
package integration

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"net/url"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/demo"
	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/mqtt"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func env(t *testing.T, k string) string {
	v := os.Getenv(k)
	if v == "" {
		t.Skipf("%s not set (run scripts/integration.sh)", k)
	}
	return v
}

func freshDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := storage.Open(ctx, env(t, "MESHMAP_IT_DATABASE_URL"), "test", 16)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP TABLE IF EXISTS packet_log, weather_hour, terrain_height`); err != nil {
		t.Fatal(err)
	}
	if err := storage.InitSchema(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := storage.InitSchema(ctx, pool); err != nil { // idempotent
		t.Fatal(err)
	}
	if err := storage.CheckSchema(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func redisClient(t *testing.T) *cache.Client {
	c, err := cache.New(env(t, "MESHMAP_IT_REDIS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.R.FlushDB(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

type sink struct{ pool *pgxpool.Pool }

func (s sink) InsertBatch(ctx context.Context, o []*ingest.Observation) ([]int64, error) {
	return storage.InsertBatch(ctx, s.pool, o)
}
func (s sink) RecentObservation(ctx context.Context, k [16]byte, since time.Time) (int64, bool, error) {
	return storage.RecentObservation(ctx, s.pool, k, since)
}
func (s sink) AddAlsoVia(ctx context.Context, byRow map[int64][]string, since time.Time) (int64, error) {
	return storage.AddAlsoVia(ctx, s.pool, byRow, since)
}

func newPipeline(t *testing.T, pool *pgxpool.Pool, rc *cache.Client, ids *identity.Store) *ingest.Pipeline {
	kr, err := security.NewKeyring(demo.Channels())
	if err != nil {
		t.Fatal(err)
	}
	var dd ingest.Dedupe
	if rc != nil {
		dd = rc
	}
	return ingest.New(ingest.Config{QueueSize: 10000, BatchSize: 100, FlushEvery: 20 * time.Millisecond,
		ProcessOpts: ingest.Options{Keyring: kr, Identities: ids, KeyBudget: 4}}, sink{pool}, dd, nil, ids, observability.NewMetrics(), quiet)
}

func count(t *testing.T, pool *pgxpool.Pool, q string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func waitRows(t *testing.T, pool *pgxpool.Pool, atLeast int) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	last, stable := -1, 0
	for time.Now().Before(deadline) {
		n := count(t, pool, `SELECT count(*) FROM packet_log`)
		if n >= atLeast && n == last {
			stable++
			if stable >= 3 {
				return n
			}
		} else {
			stable = 0
		}
		last = n
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("rows did not settle (last %d, want >= %d)", last, atLeast)
	return 0
}

// design §10.2 tests 9 and 20 (identity part): the demo stream through the real
// pipeline; re-deliveries collapse, gateways stay distinct, identities
// rebuild from packet_log after a "restart".
func TestPipelineDemoStream(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	ids := identity.New(identity.StorageLoader(pool), quiet)
	p := newPipeline(t, pool, rc, ids)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	sim := demo.NewSimulator(demo.DefaultScenario(), 7)
	var msgs []demo.Message
	for range 400 {
		msgs = append(msgs, sim.Step()...)
	}
	for _, broker := range []string{"a", "b"} { // the whole stream arrives via two brokers
		for _, m := range msgs {
			p.Submit(ingest.RawMessage{BrokerID: broker, Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
		}
	}
	n := waitRows(t, pool, 100)
	time.Sleep(300 * time.Millisecond) // let the writer apply queued provenance updates
	cancel()
	<-done

	if d := count(t, pool, `SELECT count(*) FROM (SELECT observation_key FROM packet_log GROUP BY 1 HAVING count(*) > 1) x`); d != 0 {
		t.Fatalf("%d observation keys stored more than once", d)
	}
	// Both brokers delivered every upload (b's copies mostly long after
	// commit): every row must name the other broker in also_via, exactly once.
	if bad := count(t, pool, `SELECT count(*) FROM packet_log
		WHERE NOT (decoded_metadata->'also_via' ? (CASE broker_id WHEN 'a' THEN 'b' ELSE 'a' END))
		   OR jsonb_array_length(decoded_metadata->'also_via') <> 1`); bad != 0 {
		t.Fatalf("%d rows with incomplete or duplicated broker provenance", bad)
	}
	// Late provenance updates should be HOT (fillfactor 90): no index writes.
	_, _ = pool.Exec(context.Background(), `SELECT pg_stat_force_next_flush()`)
	upd := count(t, pool, `SELECT COALESCE(sum(n_tup_upd), 0) FROM pg_stat_user_tables WHERE relname LIKE 'packet_log_p%'`)
	hot := count(t, pool, `SELECT COALESCE(sum(n_tup_hot_upd), 0) FROM pg_stat_user_tables WHERE relname LIKE 'packet_log_p%'`)
	t.Logf("worst case (whole stream via a, then via b): provenance updates %d, HOT %d", upd, hot)
	multi := count(t, pool, `SELECT count(*) FROM (SELECT logical_packet_key FROM packet_log GROUP BY 1 HAVING count(DISTINCT gateway_node_id) > 1) x`)
	if multi == 0 {
		t.Fatal("expected logical packets heard by several gateways")
	}
	if bad := count(t, pool, `SELECT count(*) FROM packet_log WHERE signature_status NOT IN ('verified','unsigned','unverifiable','not-applicable')`); bad != 0 {
		t.Fatal("invalid signature status stored")
	}
	if leaked := count(t, pool, `SELECT count(*) FROM packet_log WHERE decoded_metadata::text LIKE '%hei fra demo%'`); leaked != 0 {
		t.Fatal("message body stored in decoded_metadata")
	}
	if ids.Len() == 0 {
		t.Fatal("no identities promoted")
	}
	// Restart: a fresh store rebuilt from packet_log alone matches.
	rebuilt := identity.New(identity.StorageLoader(pool), quiet)
	if err := rebuilt.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rebuilt.Len() != ids.Len() {
		t.Fatalf("rebuilt %d identities, live store had %d", rebuilt.Len(), ids.Len())
	}
	// A top-up from nothing reads them all too, and one after it adds none.
	topped := identity.New(identity.StorageLoader(pool), quiet)
	for range 2 {
		if err := topped.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if topped.Len() != ids.Len() {
		t.Fatalf("topped up %d identities, live store had %d", topped.Len(), ids.Len())
	}
	// Each verified node's newest announced key is served, and in the demo
	// (no key changes) it is the trusted one.
	trusted, err := storage.VerifiedIdentities(context.Background(), pool, nil, 0)
	if err != nil || len(trusted) == 0 {
		t.Fatalf("verified identities: %v (%d)", err, len(trusted))
	}
	for _, id := range trusted {
		k, err := storage.LatestAnnouncedKey(context.Background(), pool, id.Node)
		if err != nil || k.PublicKey != id.PublicKey || k.At.Before(id.Since) {
			t.Fatalf("node %08x: announced %+v (%v), trusted %s", id.Node, k, err, id.PublicKey)
		}
	}
	if _, err := storage.LatestAnnouncedKey(context.Background(), pool, 0x7fff_fff1); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("unknown node: %v", err)
	}
	t.Logf("%d rows, %d multi-gateway logical packets, %d identities", n, multi, ids.Len())
}

// Realistic bridging: broker b delivers each upload 0-3 s after broker a.
// Most copies are merged in memory; the rest become row updates.
func TestBridgedBrokerLag(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	ids := identity.New(func(context.Context, int64) ([]storage.IdentityRow, int64, error) { return nil, 0, nil }, quiet)
	p := newPipeline(t, pool, rc, ids)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	sim := demo.NewSimulator(demo.DefaultScenario(), 11)
	lagRand := rand.New(rand.NewPCG(1, 2))
	var wg sync.WaitGroup
	start := time.Now()
	for range 150 { // ~150 ticks at 50/s
		for _, m := range sim.Step() {
			p.Submit(ingest.RawMessage{BrokerID: "a", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
			// Typical bridge delay is tens of ms with a long tail.
			lag := time.Duration(lagRand.ExpFloat64() * float64(150*time.Millisecond))
			lag = min(lag, 3*time.Second)
			wg.Add(1)
			go func(m demo.Message) {
				defer wg.Done()
				time.Sleep(lag)
				p.Submit(ingest.RawMessage{BrokerID: "b", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
			}(m)
		}
		time.Sleep(20 * time.Millisecond)
	}
	wg.Wait()
	time.Sleep(500 * time.Millisecond)
	cancel()
	<-done
	_, _ = pool.Exec(context.Background(), `SELECT pg_stat_force_next_flush()`)
	rows := count(t, pool, `SELECT count(*) FROM packet_log`)
	inMem := count(t, pool, `SELECT count(*) FROM packet_log WHERE decoded_metadata->'also_via' IS NOT NULL`)
	upd := count(t, pool, `SELECT COALESCE(sum(n_tup_upd), 0) FROM pg_stat_user_tables WHERE relname LIKE 'packet_log_p%'`)
	hot := count(t, pool, `SELECT COALESCE(sum(n_tup_hot_upd), 0) FROM pg_stat_user_tables WHERE relname LIKE 'packet_log_p%'`)
	t.Logf("%d rows over %s; %d with also_via; %d needed a row update (%d HOT)", rows, time.Since(start).Round(time.Second), inMem, upd, hot)
	if bad := count(t, pool, `SELECT count(*) FROM packet_log WHERE NOT (decoded_metadata->'also_via' ? (CASE broker_id WHEN 'a' THEN 'b' ELSE 'a' END))`); bad != 0 {
		t.Fatalf("%d rows missing the other broker", bad)
	}
}

// Redis unavailable: dedupe falls back to the database.
func TestDedupeWithoutRedis(t *testing.T) {
	pool := freshDB(t)
	ids := identity.New(func(context.Context, int64) ([]storage.IdentityRow, int64, error) { return nil, 0, nil }, quiet)
	p := newPipeline(t, pool, nil, ids)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	sim := demo.NewSimulator(demo.DefaultScenario(), 3)
	var msgs []demo.Message
	for range 60 {
		msgs = append(msgs, sim.Step()...)
	}
	for _, m := range msgs {
		p.Submit(ingest.RawMessage{BrokerID: "a", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
	}
	waitRows(t, pool, 10)
	for _, m := range msgs { // second broker delivers again after commit
		p.Submit(ingest.RawMessage{BrokerID: "b", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
	}
	time.Sleep(time.Second)
	cancel()
	<-done
	if d := count(t, pool, `SELECT count(*) FROM (SELECT observation_key FROM packet_log GROUP BY 1 HAVING count(*) > 1) x`); d != 0 {
		t.Fatalf("%d duplicates stored without Redis", d)
	}
	if bad := count(t, pool, `SELECT count(*) FROM packet_log WHERE NOT (decoded_metadata->'also_via' ? 'b')`); bad != 0 {
		t.Fatalf("%d rows missing broker b in also_via", bad)
	}
}

// design §10.2 test 33: retention deletes only expired rows, is repeatable, never
// runs concurrently, and leaves packet_log the only table of mesh data.
func TestRetention(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC) // Oct 31 - 6 months, clamped
	const insert = `INSERT INTO packet_log (observed_at, broker_id, mqtt_topic, source_node_id, packet_type, logical_packet_key, observation_key, signature_status, decode_version, envelope_bytes)
		SELECT $1::timestamptz - make_interval(mins => g), 't', 't', 1, 'other', '\x00', decode(md5(random()::text || g), 'hex'), 'unsigned', 1, '\x00'
		FROM generate_series($2::int, $3::int) g`
	if err := storage.EnsurePartitions(ctx, pool, cutoff.Add(-12000*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, cutoff, 1, 12000); err != nil { // 12 000 expired rows
		t.Fatal(err)
	}
	// March lies wholly before the cutoff: its partition is dropped (D-056).
	march := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	if err := storage.EnsurePartitions(ctx, pool, march, march); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, march, 1, 500); err != nil {
		t.Fatal(err)
	}
	// A dropped month is counted by the planner's estimate (D-166).
	if _, err := pool.Exec(ctx, `ANALYZE packet_log_p202603`); err != nil {
		t.Fatal(err)
	}
	ins := func(at time.Time) {
		if _, err := pool.Exec(ctx, insert, at, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	// Weather goes with the mesh data it sits beside (D-133).
	if _, err := pool.Exec(ctx, `INSERT INTO weather_hour (cell_x, cell_y, valid_at, fetched_at) VALUES (1, 1, $1, $2), (1, 1, $3, $2)`,
		cutoff.Add(-time.Hour), now, cutoff); err != nil {
		t.Fatal(err)
	}
	ins(cutoff)                       // exactly on the boundary: kept (delete is observed_at < cutoff)
	ins(cutoff.Add(time.Millisecond)) // kept
	ins(now.Add(-time.Hour))          // kept

	r := &maintenance.Runner{Pool: pool, Cache: rc, Months: 6, Interval: 24 * time.Hour, Log: quiet, Now: func() time.Time { return now }}
	// Concurrency: hold the lock elsewhere -> skipped.
	conn, _ := pool.Acquire(ctx)
	conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('meshmap:maintenance'))`) //nolint:errcheck
	if _, err := r.RunOnce(ctx); !errors.Is(err, maintenance.ErrLocked) {
		t.Fatalf("want ErrLocked, got %v", err)
	}
	conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('meshmap:maintenance'))`) //nolint:errcheck
	conn.Release()

	st, err := r.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.DeletedRows != 12500 || !st.Cutoff.Equal(cutoff) {
		t.Fatalf("deleted %d (cutoff %s), want 12500 (cutoff %s)", st.DeletedRows, st.Cutoff, cutoff)
	}
	if months, _ := storage.Partitions(ctx, pool); len(months) == 0 || months[0].Month() != time.April {
		t.Fatalf("oldest partition after retention: %v, want April", months)
	}
	if n := count(t, pool, `SELECT count(*) FROM packet_log`); n != 3 {
		t.Fatalf("%d rows left, want 3", n)
	}
	st2, err := r.RunOnce(ctx)
	if err != nil || st2.DeletedRows != 0 {
		t.Fatalf("second run: %+v %v", st2, err)
	}
	if got, _ := maintenance.LastStatus(ctx, rc); got == nil || got.DeletedRows != 0 {
		t.Fatal("status not shared via Redis")
	}
	if n := count(t, pool, `SELECT count(*) FROM weather_hour`); n != 1 {
		t.Fatalf("%d weather hours left, want the one on the cutoff", n)
	}
	tables, _ := storage.ApplicationTables(ctx, pool)
	if !slices.Equal(tables, storage.Tables) {
		t.Fatalf("application tables: %v", tables)
	}
}

// design §10.2 tests 10 and 35 (partial): real broker; garbage never crashes the
// client; client reconnects and resubscribes after the broker drops it.
// Subtests share got; each resets it.
func TestMQTTClientRobustness(t *testing.T) {
	host := env(t, "MESHMAP_IT_MQTT_HOST")
	var mu sync.Mutex
	var got []ingest.RawMessage
	b := config.Broker{ID: "it", Host: host, Port: 1883, Protocol: "v5", ClientID: "meshmap-it-sub", Topics: []config.Subscription{{Filter: "msh/#"}}}
	for _, proto := range []string{"v5", "v311"} {
		t.Run(proto, func(t *testing.T) {
			mu.Lock()
			got = nil
			mu.Unlock()
			b.Protocol, b.ClientID = proto, "meshmap-it-"+proto
			cl, err := mqtt.New(b, func(m ingest.RawMessage) { mu.Lock(); got = append(got, m); mu.Unlock() }, observability.NewMetrics(), quiet)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go cl.Run(ctx) //nolint:errcheck
			deadline := time.Now().Add(10 * time.Second)
			for cl.State() != mqtt.StateUp && time.Now().Before(deadline) {
				time.Sleep(50 * time.Millisecond)
			}
			if cl.State() != mqtt.StateUp {
				t.Fatal("client did not connect")
			}
			time.Sleep(300 * time.Millisecond) // subscription
			pub := publisher(t, host)
			payloads := [][]byte{{0xff, 0xff, 0xff}, make([]byte, 5000), []byte("\x00\x01 <script>"), {}}
			for _, p := range payloads {
				_, _ = pub.Publish(context.Background(), &paho.Publish{Topic: "msh/EU_868/2/e/LongFast/!aabbccdd", Payload: p})
			}
			_, _ = pub.Publish(context.Background(), &paho.Publish{Topic: "msh/x", Payload: []byte("missing segments")})
			time.Sleep(500 * time.Millisecond)
			mu.Lock()
			n := len(got)
			// 5000-byte payload is dropped at the client (oversize); the rest are delivered for the pipeline to reject.
			if n != 4 {
				mu.Unlock()
				t.Fatalf("delivered %d messages, want 4", n)
			}
			for _, m := range got {
				if _, err := ingest.Process(m, ingest.Options{Keyring: mustKeyring(t), Identities: noIDs{}, KeyBudget: 4}); err == nil {
					t.Fatal("garbage accepted")
				}
				if m.ObservedAt.IsZero() || m.BrokerID != "it" {
					t.Fatal("ObservedAt/BrokerID not stamped at receipt")
				}
			}
			mu.Unlock()

			// Session takeover: another client with our client ID forces a
			// disconnect; we must reconnect and resubscribe on our own.
			thief := connect(t, host, b.ClientID)
			deadline = time.Now().Add(10 * time.Second)
			for cl.State() == mqtt.StateUp && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
			}
			if cl.State() == mqtt.StateUp {
				t.Fatal("takeover did not disconnect the client")
			}
			_ = thief.Disconnect(context.Background())
			deadline = time.Now().Add(90 * time.Second)
			for cl.State() != mqtt.StateUp && time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
			}
			if cl.State() != mqtt.StateUp {
				t.Fatal("client did not reconnect")
			}
			time.Sleep(500 * time.Millisecond)
			mu.Lock()
			before := len(got)
			mu.Unlock()
			_, _ = pub.Publish(context.Background(), &paho.Publish{Topic: "msh/EU_868/2/e/LongFast/!aabbccdd", Payload: []byte{1}})
			deadline = time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				mu.Lock()
				n := len(got)
				mu.Unlock()
				if n > before {
					return
				}
				time.Sleep(50 * time.Millisecond)
			}
			t.Fatal("no delivery after reconnect: subscription not restored")
		})
	}
}

type noIDs struct{}

func (noIDs) Lookup(uint32) (security.Identity, bool) { return security.Identity{}, false }

func mustKeyring(t *testing.T) *security.Keyring {
	kr, err := security.NewKeyring(demo.Channels())
	if err != nil {
		t.Fatal(err)
	}
	return kr
}

func publisher(t *testing.T, host string) *autopaho.ConnectionManager {
	t.Helper()
	return connect(t, host, "meshmap-it-pub-"+time.Now().Format("150405.000"))
}

func connect(t *testing.T, host, clientID string) *autopaho.ConnectionManager {
	t.Helper()
	u, _ := url.Parse("mqtt://" + host + ":1883")
	up := make(chan struct{}, 1)
	cm, err := autopaho.NewConnection(context.Background(), autopaho.ClientConfig{ServerUrls: []*url.URL{u}, KeepAlive: 10,
		OnConnectionUp: func(*autopaho.ConnectionManager, *paho.Connack) { up <- struct{}{} },
		ClientConfig:   paho.ClientConfig{ClientID: clientID}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-up:
	case <-time.After(10 * time.Second):
		t.Fatal("publisher did not connect")
	}
	t.Cleanup(func() { _ = cm.Disconnect(context.Background()) })
	return cm
}
