package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	dto "github.com/prometheus/client_model/go"
	"io"
	"log/slog"
	"math"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/protocol/ports"
	"github.com/868-no/map/internal/security"
)

type memSink struct {
	mu       sync.Mutex
	rows     []*Observation
	failNext int
	refuse   func(*Observation) bool // rows the "database" cannot hold
	attempts int
}

type sqlStateErr string

func (e sqlStateErr) Error() string    { return "SQLSTATE " + string(e) }
func (e sqlStateErr) SQLState() string { return string(e) }

func (s *memSink) InsertBatch(_ context.Context, obs []*Observation) ([]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts++
	if s.failNext > 0 {
		s.failNext--
		return nil, errors.New("db down")
	}
	for _, o := range obs {
		if s.refuse != nil && s.refuse(o) {
			return nil, fmt.Errorf("copy: %w", sqlStateErr("22021"))
		}
	}
	ids := make([]int64, len(obs))
	for i, o := range obs {
		s.rows = append(s.rows, o)
		ids[i] = int64(len(s.rows))
	}
	return ids, nil
}

func (s *memSink) RecentObservation(_ context.Context, k [16]byte, since time.Time) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.rows {
		if r.ObservationKey == k && !r.ObservedAt.Before(since) {
			return int64(i + 1), true, nil
		}
	}
	return 0, false, nil
}

func (s *memSink) AddAlsoVia(_ context.Context, byRow map[int64][]string, _ time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, brokers := range byRow {
		r := s.rows[id-1]
		changed := false
		for _, b := range brokers {
			if b != r.BrokerID && !slices.Contains(r.Meta.AlsoVia, b) {
				r.Meta.AlsoVia = append(r.Meta.AlsoVia, b)
				changed = true
			}
		}
		if changed {
			n++
		}
	}
	return n, nil
}

func (s *memSink) row(i int) Observation { s.mu.Lock(); defer s.mu.Unlock(); return *s.rows[i] }

func (s *memSink) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.rows) }

type promoted struct {
	mu  sync.Mutex
	ids []security.Identity
}

func (p *promoted) Promote(id security.Identity) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ids = append(p.ids, id)
	return true
}

func newTestPipeline(t *testing.T, sink *memSink, queue int) (*Pipeline, *promoted) {
	pr := &promoted{}
	p := New(Config{QueueSize: queue, Workers: 2, BatchSize: 10, FlushEvery: 10 * time.Millisecond, ProcessOpts: opts(t, longFast)},
		sink, nil, nil, pr, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	return p, pr
}

// dropped reads the pipeline's dropped-message counter for reason.
func dropped(t *testing.T, p *Pipeline, reason string) float64 {
	t.Helper()
	var m dto.Metric
	if err := p.m.Dropped.WithLabelValues(reason).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetCounter().GetValue()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// design §10.2 test 9 end to end through the pipeline, plus writer retry on DB
// failure: one row per gateway reception; a copy from another broker is
// recorded in also_via, a same-broker retry only counted.
func TestPipelineDedupeAndRetry(t *testing.T) {
	sink := &memSink{failNext: 2}
	p, _ := newTestPipeline(t, sink, 100)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	pk := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	for _, broker := range []string{"a", "b", "a"} { // same upload via two brokers + QoS retry
		m := msg(topicLF, b)
		m.BrokerID = broker
		p.Submit(m)
	}
	pk.gw, pk.snr = "!ccddeeff", -2
	p.Submit(msg("msh/EU_868/NO/Trøndelag/2/e/LongFast/!ccddeeff", envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")))

	waitFor(t, func() bool { return sink.count() == 2 })
	time.Sleep(50 * time.Millisecond)
	if sink.count() != 2 {
		t.Fatalf("want 2 observations (one per gateway), got %d", sink.count())
	}
	if sink.rows[0].LogicalKey != sink.rows[1].LogicalKey {
		t.Fatal("both gateways heard the same logical packet")
	}
	var gw1 *Observation
	for _, r := range sink.rows {
		if *r.Gateway == 0xaabbccdd {
			gw1 = r
		}
	}
	// Either broker may win the race; the other must be in also_via.
	brokers := append([]string{gw1.BrokerID}, gw1.Meta.AlsoVia...)
	slices.Sort(brokers)
	if !slices.Equal(brokers, []string{"a", "b"}) {
		t.Fatalf("broker provenance: first=%s also_via=%v", gw1.BrokerID, gw1.Meta.AlsoVia)
	}
	cancel()
	<-done
}

type flakyDedupe struct {
	mu            sync.Mutex
	down          bool
	lookups, mark int
}

func (d *flakyDedupe) LookupObservations(_ context.Context, keys [][16]byte) ([]int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lookups++
	if d.down {
		return nil, errors.New("redis timeout")
	}
	return make([]int64, len(keys)), nil
}

func (d *flakyDedupe) MarkObservations(context.Context, [][16]byte, []int64, time.Duration) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.mark++
	if d.down {
		return errors.New("redis timeout")
	}
	return nil
}

func (d *flakyDedupe) calls() (int, int) { d.mu.Lock(); defer d.mu.Unlock(); return d.lookups, d.mark }

// D-166: after a Redis error, dedupe skips Redis for a while (the database
// answers) instead of paying a timeout per message, and resumes afterwards.
func TestPipelineDedupeBackoff(t *testing.T) {
	sink, dd := &memSink{}, &flakyDedupe{down: true}
	p := New(Config{QueueSize: 100, Workers: 1, BatchSize: 10, FlushEvery: 5 * time.Millisecond, ProcessOpts: opts(t, longFast)},
		sink, dd, nil, &promoted{}, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	send := func(id uint32) {
		pk := pkt{from: 0x11111111, id: id, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
		p.Submit(msg(topicLF, envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")))
	}
	for id := uint32(1); id <= 20; id++ {
		send(id)
	}
	send(1) // a duplicate is still caught, by the in-process set
	waitFor(t, func() bool { return sink.count() == 20 })
	time.Sleep(30 * time.Millisecond)
	if l, m := dd.calls(); l != 1 || m != 0 || sink.count() != 20 {
		t.Fatalf("during the outage: %d lookups, %d marks, %d rows; want 1, 0, 20", l, m, sink.count())
	}
	// The backoff ends and Redis is back: it is used again.
	dd.mu.Lock()
	dd.down = false
	dd.mu.Unlock()
	p.dedupeRetryAt.Store(0)
	send(21)
	waitFor(t, func() bool { _, m := dd.calls(); return m == 1 })
	if l, _ := dd.calls(); l != 2 || p.dedupeDown.Load() {
		t.Fatalf("after the outage: %d lookups, down %v", l, p.dedupeDown.Load())
	}
	cancel()
	<-done
}

// A copy from another broker long after commit extends the row's also_via
// by primary key; a same-broker replay changes nothing.
func TestPipelineLateCrossBrokerProvenance(t *testing.T) {
	sink := &memSink{}
	p, _ := newTestPipeline(t, sink, 100)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	pk := pkt{from: 0x11111111, id: 9, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	send := func(broker string) {
		m := msg(topicLF, b)
		m.BrokerID = broker
		p.Submit(m)
	}
	send("a")
	waitFor(t, func() bool { return sink.count() == 1 })
	time.Sleep(50 * time.Millisecond)
	send("a") // replay on the same broker
	send("c")
	send("b")
	send("c")
	waitFor(t, func() bool { return len(sink.row(0).Meta.AlsoVia) == 2 })
	time.Sleep(100 * time.Millisecond)
	r := sink.row(0)
	got := append([]string(nil), r.Meta.AlsoVia...)
	slices.Sort(got)
	if sink.count() != 1 || r.BrokerID != "a" || !slices.Equal(got, []string{"b", "c"}) {
		t.Fatalf("rows=%d first=%s also_via=%v", sink.count(), r.BrokerID, r.Meta.AlsoVia)
	}
	cancel()
	<-done
}

func TestPipelineQueueFullDrops(t *testing.T) {
	sink := &memSink{}
	p, _ := newTestPipeline(t, sink, 2)
	for range 10 { // not running: queue fills
		p.Submit(msg(topicLF, []byte{1}))
	}
	if n := dropped(t, p, "queue_full"); n != 8 {
		t.Fatalf("dropped %v, want 8", n)
	}
}

func TestPipelinePromotesAfterCommit(t *testing.T) {
	sink := &memSink{}
	p, pr := newTestPipeline(t, sink, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	p.Submit(msg(topicLF, signedNodeInfoEnvelope(t, 1)))
	waitFor(t, func() bool { pr.mu.Lock(); defer pr.mu.Unlock(); return len(pr.ids) == 1 })
	if pr.ids[0].RowID != 1 {
		t.Fatalf("promotion must carry the committed row id, got %d", pr.ids[0].RowID)
	}
	cancel()
	<-done
}

func TestLiveEventCarriesTheRow(t *testing.T) {
	o := &Observation{Source: 7, PacketType: "position", ObservedAt: time.UnixMilli(1_800_000_000_123)}
	raw, err := LiveRow(o, 42)
	var r obsrow.ObsRow
	if err == nil {
		err = json.Unmarshal(raw, &r)
	}
	if err != nil || r.ID != 42 || r.Source != 7 || r.T != 1_800_000_000_123 || r.Type != "position" {
		t.Fatalf("live row %s: %v", raw, err)
	}
	// Byte for byte the stored encoding completed with the id (D-046).
	meta, _ := json.Marshal(o.Meta)
	if want, _ := json.Marshal(rowOf(o, 42, meta)); string(raw) != string(want) {
		t.Fatalf("live row %s, want %s", raw, want)
	}
}

// A shutdown during a database outage gives up after DrainTimeout instead
// of retrying until the process is killed; the lost rows become a gap.
func TestShutdownDuringOutageIsBounded(t *testing.T) {
	sink := &memSink{failNext: 1 << 30}
	p := New(Config{QueueSize: 10, Workers: 1, BatchSize: 10, FlushEvery: 5 * time.Millisecond, DrainTimeout: 300 * time.Millisecond, ProcessOpts: opts(t, longFast)},
		sink, nil, nil, nil, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	pk := pkt{from: 0x11111111, id: 9, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	p.Submit(msg(topicLF, envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")))
	waitFor(t, func() bool { return p.degraded.Load() })
	start := time.Now()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown hung while the database was down")
	}
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("gave up after %s, before the drain timeout", d)
	}
	if n := dropped(t, p, "shutdown_db_unavailable"); n != 1 {
		t.Fatalf("dropped %v, want 1", n)
	}
}

// Past the drain deadline the committed-check gives a row up without a
// database lookup, which with the database down could take a second per row.
func TestCommittedSkipsLookupPastDrainDeadline(t *testing.T) {
	sink := &countingSink{}
	p, _ := newTestPipeline(t, &memSink{}, 10)
	p.sink = sink
	p.stopAt.Store(time.Now().Add(-p.cfg.DrainTimeout - time.Second).UnixNano())
	p.closed.Store(true)
	if _, found, _ := p.committed(Observation{BrokerID: "a"}); found || sink.lookups != 0 {
		t.Fatalf("found %v after %d lookups past the drain deadline", found, sink.lookups)
	}
}

type countingSink struct {
	memSink
	lookups int
}

func (s *countingSink) RecentObservation(ctx context.Context, k [16]byte, since time.Time) (int64, bool, error) {
	s.lookups++
	return s.memSink.RecentObservation(ctx, k, since)
}

// Copies of a committed reception arriving from two other brokers at once
// both end up as provenance, even when one arrives while the other is
// briefly claimed for the committed-check (it used to be dropped with that
// claim; seen as a flaky TestPipelineLateCrossBrokerProvenance in CI).
func TestConcurrentLateCopiesKeepProvenance(t *testing.T) {
	p, _ := newTestPipeline(t, &memSink{}, 10)
	for i := range 3000 {
		var k [16]byte
		k[0], k[1] = byte(i), byte(i>>8)
		p.recent.add(k, 1, []string{"a"}, time.Now())
		var wg sync.WaitGroup
		for _, b := range []string{"b", "c"} {
			wg.Add(1)
			go func() { defer wg.Done(); p.claim(Observation{ObservationKey: k, BrokerID: b}) }()
		}
		wg.Wait()
		p.pendMu.Lock()
		got := append([]string(nil), p.pending[1]...)
		p.pending = map[int64][]string{}
		p.pendMu.Unlock()
		slices.Sort(got)
		if !slices.Equal(got, []string{"b", "c"}) {
			t.Fatalf("iteration %d: provenance %v, want [b c]", i, got)
		}
	}
}

// A row the database refuses (SQLSTATE class 22/23) is isolated and dropped
// instead of retrying its batch forever; the rest of the batch is stored.
func TestFlushDropsRowsTheDatabaseRefuses(t *testing.T) {
	sink := &memSink{refuse: func(o *Observation) bool { return o.Topic == "bad" }}
	p, _ := newTestPipeline(t, sink, 10)
	batch := make([]*Observation, 9)
	for i := range batch {
		batch[i] = &Observation{Topic: "ok", BrokerID: "a", ObservedAt: time.Now()}
		batch[i].ObservationKey[0] = byte(i)
		p.inflight[batch[i].ObservationKey] = "a"
	}
	batch[3].Topic, batch[7].Topic = "bad", "bad"
	done := make(chan struct{})
	go func() { p.flush(batch); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("flush kept retrying a batch the database refuses")
	}
	if sink.count() != 7 {
		t.Fatalf("stored %d rows, want 7", sink.count())
	}
	if len(p.inflight) != 0 {
		t.Fatalf("claims left in flight: %d", len(p.inflight))
	}
	if sink.attempts > 20 {
		t.Fatalf("%d insert attempts for 9 rows", sink.attempts)
	}
	// A batch the database refuses whole is its fault, not the data's (a
	// schema out of step): the rows are kept and retried, not dropped.
	whole := &memSink{}
	whole.refuse = func(*Observation) bool { return whole.attempts < 10 } // called under whole.mu
	q, _ := newTestPipeline(t, whole, 10)
	rows := make([]*Observation, 4)
	for i := range rows {
		rows[i] = &Observation{Topic: "ok", BrokerID: "a", ObservedAt: time.Now()}
		rows[i].ObservationKey[0] = byte(100 + i)
		q.inflight[rows[i].ObservationKey] = "a"
	}
	done = make(chan struct{})
	go func() { q.flush(rows); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("a wholly refused batch was never stored")
	}
	if whole.count() != 4 {
		t.Fatalf("stored %d rows after the database recovered, want 4", whole.count())
	}
	// Halved once (1+6 inserts), then retried whole without halving again
	// (that waits a minute): attempts 8 and 9 are refused and the 10th
	// stores the batch.
	if whole.attempts != 10 {
		t.Fatalf("%d insert attempts, want 10 (the batch halved once)", whole.attempts)
	}
	// Transient and partition errors stay retryable.
	if Permanent(errors.New("db down")) || Permanent(sqlStateErr("08006")) || Permanent(fmt.Errorf("%w: %w", ErrNoPartition, sqlStateErr("23514"))) {
		t.Fatal("transient error classed as permanent")
	}
	if !Permanent(sqlStateErr("23502")) {
		t.Fatal("integrity error classed as transient")
	}
	// A row that cannot be encoded is its own fault, like one the database
	// refuses: never retried.
	nan := &Observation{Meta: Metadata{Decoded: ports.Decoded{Position: &ports.Position{Lat: math.NaN()}}}}
	if _, _, err := nan.Encoded(); !errors.Is(err, ErrUnencodable) || !Permanent(fmt.Errorf("copy: %w", err)) {
		t.Fatalf("encoding failure %v not classed as permanent", err)
	}
}

// rejected reads the pipeline's rejected-row counter for category.
func rejected(t *testing.T, p *Pipeline, category string) float64 {
	t.Helper()
	var m dto.Metric
	if err := p.m.Rejected.WithLabelValues(category).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetCounter().GetValue()
}

// claimed builds an observation already claimed in flight, as the writer gets it.
func claimed(p *Pipeline, topic string, key byte) *Observation {
	o := &Observation{Topic: topic, BrokerID: "a", ObservedAt: time.Now()}
	o.ObservationKey[0] = key
	p.inflightMu.Lock()
	p.inflight[o.ObservationKey] = "a"
	p.inflightMu.Unlock()
	return o
}

// At live traffic most batches hold one row. A lone row the database
// refuses may be refused for the database's sake (a schema out of step
// during a deploy): it is kept and retried, with the writer degraded, and
// stored once the database takes rows again.
func TestFlushHoldsALoneRefusedRow(t *testing.T) {
	sink := &memSink{}
	sink.refuse = func(*Observation) bool { return sink.attempts < 3 } // called under sink.mu
	p, _ := newTestPipeline(t, sink, 10)
	one := claimed(p, "ok", 1)
	done := make(chan struct{})
	go func() { p.flush([]*Observation{one}); close(done) }()
	waitFor(t, func() bool { ok, _ := p.Healthy(); return !ok })
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a lone refused row was never stored after the database recovered")
	}
	if sink.count() != 1 || rejected(t, p, "db_refused_row") != 0 || len(p.inflight) != 0 {
		t.Fatalf("stored %d, dropped %v, claims %d; want 1, 0, 0", sink.count(), rejected(t, p, "db_refused_row"), len(p.inflight))
	}
	if ok, why := p.Healthy(); !ok {
		t.Fatalf("still degraded after the row was stored: %s", why)
	}
}

// A held lone row is dropped once the database takes a row that arrived
// after it: then the refusal is down to its own data. The new row is stored
// at once, not after the held row's backoff.
func TestFlushDropsAHeldRowOnceAnotherIsTaken(t *testing.T) {
	sink := &memSink{refuse: func(o *Observation) bool { return o.Topic == "bad" }}
	p, _ := newTestPipeline(t, sink, 10)
	bad := claimed(p, "bad", 1)
	done := make(chan struct{})
	go func() { p.flush([]*Observation{bad}); close(done) }()
	waitFor(t, func() bool { ok, _ := p.Healthy(); return !ok })
	if rejected(t, p, "db_refused_row") != 0 {
		t.Fatal("a lone refused row was dropped before the database took any other")
	}
	p.toWriter <- claimed(p, "ok", 2)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the held row was kept after the database took a newer one")
	}
	if sink.count() != 1 || sink.row(0).Topic != "ok" || rejected(t, p, "db_refused_row") != 1 {
		t.Fatalf("stored %d, dropped %v; want the new row stored and the held one dropped", sink.count(), rejected(t, p, "db_refused_row"))
	}
	if len(p.inflight) != 0 {
		t.Fatalf("claims left in flight: %d", len(p.inflight))
	}
	if ok, why := p.Healthy(); !ok {
		t.Fatalf("still degraded: %s", why)
	}
}

// A row that cannot be encoded is dropped without an insert, even alone:
// no database could take it.
func TestFlushDropsUnencodableRows(t *testing.T) {
	sink := &memSink{}
	p, _ := newTestPipeline(t, sink, 10)
	nan := claimed(p, "nan", 1)
	nan.Meta.Position = &ports.Position{Lat: math.NaN()}
	ok := claimed(p, "ok", 2)
	p.flush([]*Observation{nan, ok})
	alone := claimed(p, "nan", 3)
	alone.Meta.Position = &ports.Position{Lon: math.Inf(1)}
	p.flush([]*Observation{alone})
	if sink.count() != 1 || sink.row(0).Topic != "ok" || sink.attempts != 1 {
		t.Fatalf("stored %d rows in %d inserts; want only the encodable one, in one", sink.count(), sink.attempts)
	}
	if n := rejected(t, p, "unencodable_row"); n != 2 || len(p.inflight) != 0 {
		t.Fatalf("%v unencodable rows counted, %d claims left; want 2, 0", n, len(p.inflight))
	}
}

// isolateSink refuses any batch holding a "bad" row, and fails a lone
// "flaky" row for a transient reason.
type isolateSink struct{ memSink }

func (s *isolateSink) InsertBatch(ctx context.Context, obs []*Observation) ([]int64, error) {
	for _, o := range obs {
		if o.Topic == "bad" {
			return nil, fmt.Errorf("copy: %w", sqlStateErr("22021"))
		}
	}
	if len(obs) == 1 && obs[0].Topic == "flaky" {
		return nil, errors.New("db down")
	}
	return s.memSink.InsertBatch(ctx, obs)
}

// Halving a refused batch keeps each row in exactly one outcome: the halves'
// results share the batch's array, and joining them must not overwrite one
// with the other (a row lost there stays claimed forever).
func TestIsolateKeepsEveryRow(t *testing.T) {
	p, _ := newTestPipeline(t, &memSink{}, 10)
	p.sink = &isolateSink{}
	topics := []string{"bad", "bad", "flaky", "bad"}
	batch := make([]*Observation, len(topics), 16) // spare capacity, as the writer's batch has
	for i, top := range topics {
		batch[i] = &Observation{Topic: top, BrokerID: "a", ObservedAt: time.Now()}
		batch[i].ObservationKey[0] = byte(i)
	}
	refused, again := p.isolate(batch, time.Second)
	keys := func(os []*Observation) (out []byte) {
		for _, o := range os {
			out = append(out, o.ObservationKey[0])
		}
		return out
	}
	if !slices.Equal(keys(refused), []byte{0, 1, 3}) || !slices.Equal(keys(again), []byte{2}) {
		t.Fatalf("refused %v, again %v; want [0 1 3], [2]", keys(refused), keys(again))
	}
}

// After a restart the in-process set is empty: a copy found in the database
// is held in process from then on, and a same-broker replay of it is not
// counted as another broker's delivery.
func TestReplayFoundInDatabaseAfterRestart(t *testing.T) {
	sink := &memSink{}
	pk := pkt{from: 0x11111111, id: 9, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	run := func(p *Pipeline, copies int) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { p.Run(ctx); close(done) }()
		for range copies {
			m := msg(topicLF, b)
			m.BrokerID = "a"
			p.Submit(m)
		}
		waitFor(t, func() bool { return sink.count() == 1 && len(p.queue) == 0 })
		time.Sleep(50 * time.Millisecond)
		cancel()
		<-done
	}
	first, _ := newTestPipeline(t, sink, 100)
	run(first, 1)
	restarted, _ := newTestPipeline(t, sink, 100)
	run(restarted, 2)
	if _, ok := restarted.recent.get(sink.row(0).ObservationKey, time.Now()); !ok {
		t.Fatal("the copy found in the database is not held in process")
	}
	var m dto.Metric
	if err := restarted.m.DupDeliveries.WithLabelValues("a").Write(&m); err != nil {
		t.Fatal(err)
	}
	if n := m.GetCounter().GetValue(); n != 0 {
		t.Fatalf("same-broker replays counted as %v cross-broker deliveries", n)
	}
	if r := sink.row(0); sink.count() != 1 || len(r.Meta.AlsoVia) != 0 {
		t.Fatalf("rows %d, also_via %v", sink.count(), r.Meta.AlsoVia)
	}
}
