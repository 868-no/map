package ingest

import (
	"context"
	"errors"
	"log/slog"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/security"
)

// Sink persists batches (storage package, adapted in cmd).
type Sink interface {
	InsertBatch(ctx context.Context, obs []*Observation) ([]int64, error)
	// RecentObservation returns the row id of a recently stored observation.
	RecentObservation(ctx context.Context, key [16]byte, since time.Time) (int64, bool, error)
	// AddAlsoVia appends brokers to rows' decoded_metadata.also_via, skipping
	// brokers already recorded (first broker or also_via). Every row was
	// observed at or after since (a bound that lets storage skip partitions).
	AddAlsoVia(ctx context.Context, byRow map[int64][]string, since time.Time) (int64, error)
}

// Dedupe is the shared recent-observation index (Redis). May be nil.
type Dedupe interface {
	// LookupObservations returns the row id per key, 0 when not seen.
	LookupObservations(ctx context.Context, keys [][16]byte) ([]int64, error)
	MarkObservations(ctx context.Context, keys [][16]byte, ids []int64) error
}

// Publisher fans out live events (Redis pub/sub or in-process). May be nil.
type Publisher interface {
	PublishLive(ctx context.Context, events []LiveEvent)
}

// Promoter records identities after their rows commit.
type Promoter interface {
	Promote(security.Identity) bool
}

// LiveEvent announces an accepted observation to SSE clients: its row id,
// observed_at and the full compact row, identical to what /observations
// returns (D-033, D-041). Never payload bytes or envelope data.
type LiveEvent struct {
	ID  int64          `json:"id"`
	T   time.Time      `json:"t"`
	Row *obsrow.ObsRow `json:"row"`
}

// Config sizes the pipeline.
type Config struct {
	QueueSize  int
	Workers    int
	BatchSize  int
	FlushEvery time.Duration
	DedupeTTL  time.Duration
	// DrainTimeout bounds how long a shutdown keeps retrying a failing
	// write; rows still unwritten then are counted as a gap.
	DrainTimeout time.Duration
	ProcessOpts  Options
}

// Pipeline is the staged ingest pipeline: bounded queue -> worker pool ->
// single batch writer.
type Pipeline struct {
	cfg     Config
	sink    Sink
	dedupe  Dedupe
	pub     Publisher
	promote Promoter
	m       *observability.Metrics
	log     *slog.Logger

	queue    chan RawMessage
	toWriter chan *Observation
	recent   *ttlSet
	// inflight holds keys claimed by a worker and not yet committed. Once an
	// observation is handed to the writer it is retried until it commits, so
	// a claim is never abandoned and cannot suppress a later genuine copy.
	inflightMu sync.Mutex
	inflight   map[[16]byte]string   // observation key -> broker that claimed it
	alsoVia    map[[16]byte][]string // other brokers delivering an in-flight key
	// pending holds late cross-broker deliveries of committed rows, applied
	// by the writer as one batched UPDATE per flush.
	pendMu   sync.Mutex
	pending  map[int64][]string
	closed   atomic.Bool
	closeMu  sync.RWMutex // Submit sends under the read lock; Run closes queue under the write lock
	stopAt   atomic.Int64 // UnixNano when shutdown began
	degraded atomic.Bool  // writer currently failing
	lastOK   atomic.Int64

	gapMu sync.Mutex
	gaps  []Gap
}

// Gap is an interval where ingestion lost data (queue full); bounded
// operational telemetry, not packet history.
type Gap struct {
	Start, End time.Time
	Dropped    int
	Reason     string
}

// New builds a pipeline. dedupe and pub may be nil.
func New(cfg Config, sink Sink, dedupe Dedupe, pub Publisher, promote Promoter, m *observability.Metrics, log *slog.Logger) *Pipeline {
	if cfg.Workers <= 0 {
		cfg.Workers = runtime.GOMAXPROCS(0)
	}
	if cfg.FlushEvery <= 0 {
		cfg.FlushEvery = 200 * time.Millisecond
	}
	if cfg.DrainTimeout <= 0 {
		cfg.DrainTimeout = 10 * time.Second
	}
	if cfg.DedupeTTL <= 0 {
		cfg.DedupeTTL = 15 * time.Minute
	}
	return &Pipeline{
		cfg: cfg, sink: sink, dedupe: dedupe, pub: pub, promote: promote, m: m, log: log,
		queue:    make(chan RawMessage, cfg.QueueSize),
		toWriter: make(chan *Observation, cfg.BatchSize*2),
		recent:   newTTLSet(cfg.DedupeTTL, 200_000),
		inflight: map[[16]byte]string{},
		alsoVia:  map[[16]byte][]string{},
		pending:  map[int64][]string{},
	}
}

// Submit enqueues a message without blocking the MQTT reader. When the queue
// is full the message is dropped and counted (QoS 0 sources cannot be slowed).
func (p *Pipeline) Submit(msg RawMessage) {
	// Held across the send: Run closes the queue under the write lock, so a
	// callback still in Submit at shutdown can never send on a closed channel.
	p.closeMu.RLock()
	defer p.closeMu.RUnlock()
	if p.closed.Load() {
		p.m.Dropped.WithLabelValues("shutting_down").Inc()
		return
	}
	select {
	case p.queue <- msg:
		p.m.QueueDepth.Set(float64(len(p.queue)))
	default:
		p.m.Dropped.WithLabelValues("queue_full").Inc()
		p.noteGap(msg.ObservedAt, "queue_full")
	}
}

func (p *Pipeline) noteGap(t time.Time, reason string) {
	p.gapMu.Lock()
	defer p.gapMu.Unlock()
	if n := len(p.gaps); n > 0 && p.gaps[n-1].Reason == reason && t.Sub(p.gaps[n-1].End) < 10*time.Second {
		p.gaps[n-1].End = t
		p.gaps[n-1].Dropped++
		return
	}
	p.gaps = append(p.gaps, Gap{Start: t, End: t, Dropped: 1, Reason: reason})
	if len(p.gaps) > 256 {
		p.gaps = p.gaps[len(p.gaps)-256:]
	}
}

// Gaps returns a copy of recent ingestion gaps.
func (p *Pipeline) Gaps() []Gap {
	p.gapMu.Lock()
	defer p.gapMu.Unlock()
	return append([]Gap(nil), p.gaps...)
}

// Healthy reports whether the writer is committing and the queue is not saturated.
func (p *Pipeline) Healthy() (ok bool, reason string) {
	if p.degraded.Load() {
		return false, "database writes failing"
	}
	if len(p.queue) > cap(p.queue)*9/10 {
		return false, "ingest queue saturated"
	}
	return true, ""
}

// Run processes until ctx is cancelled, then drains the queue and flushes.
func (p *Pipeline) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < p.cfg.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.worker()
		}()
	}
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		p.writer()
	}()
	<-ctx.Done()
	p.stopAt.Store(time.Now().UnixNano())
	p.closeMu.Lock()
	p.closed.Store(true)
	close(p.queue)
	p.closeMu.Unlock()
	wg.Wait()
	close(p.toWriter)
	<-writerDone
}

func (p *Pipeline) worker() {
	for msg := range p.queue {
		p.m.QueueDepth.Set(float64(len(p.queue)))
		start := time.Now()
		// Process is bounded by its key-attempt budget (Options.KeyBudget).
		obs, err := Process(msg, p.cfg.ProcessOpts)
		p.m.ProcessLatency.Observe(time.Since(start).Seconds())
		if err != nil {
			p.m.Rejected.WithLabelValues(Category(err)).Inc()
			continue
		}
		if !p.claim(obs) {
			continue
		}
		p.toWriter <- &obs
	}
}

// claim atomically reserves an observation key for writing. It fails if the
// key is in flight or was committed recently (in-process set, Redis, or the
// database when Redis is down). Copies from another broker are recorded as
// broker provenance: in memory while in flight, as a queued row update once
// committed.
func (p *Pipeline) claim(o Observation) bool {
	k := o.ObservationKey
	p.inflightMu.Lock()
	if first, busy := p.inflight[k]; busy {
		if o.BrokerID != first && !slices.Contains(p.alsoVia[k], o.BrokerID) {
			p.alsoVia[k] = append(p.alsoVia[k], o.BrokerID)
		}
		p.inflightMu.Unlock()
		p.duplicate(o.BrokerID != first, o.BrokerID)
		return false
	}
	p.inflight[k] = o.BrokerID
	p.inflightMu.Unlock()
	id, found := p.committed(o)
	if !found {
		return true
	}
	// Copies from other brokers that arrived while this one was briefly in
	// flight (during the lookup above) were recorded against the claim;
	// they belong to the committed row too, not dropped with the claim.
	p.inflightMu.Lock()
	others := p.alsoVia[k]
	delete(p.inflight, k)
	delete(p.alsoVia, k)
	p.inflightMu.Unlock()
	cross := p.recent.addBroker(k, o.BrokerID)
	if cross && id > 0 {
		p.queueProvenance(id, o.BrokerID)
	}
	for _, b := range others {
		if p.recent.addBroker(k, b) && id > 0 {
			p.queueProvenance(id, b)
		}
	}
	p.duplicate(cross, o.BrokerID)
	return false
}

// duplicate counts a suppressed delivery. Copies from another broker are
// counted per broker; same-broker copies are QoS retries or replays.
func (p *Pipeline) duplicate(crossBroker bool, broker string) {
	p.m.Rejected.WithLabelValues("duplicate_observation").Inc()
	if crossBroker {
		p.m.DupDeliveries.WithLabelValues(broker).Inc()
	}
}

func (p *Pipeline) queueProvenance(id int64, broker string) {
	p.pendMu.Lock()
	defer p.pendMu.Unlock()
	if !slices.Contains(p.pending[id], broker) {
		p.pending[id] = append(p.pending[id], broker)
	}
}

// takeAlsoVia copies recorded broker provenance into a batch before each
// insert attempt (also picks up copies that arrived during retries).
func (p *Pipeline) takeAlsoVia(batch []*Observation) {
	p.inflightMu.Lock()
	defer p.inflightMu.Unlock()
	for _, o := range batch {
		if v := p.alsoVia[o.ObservationKey]; len(v) > 0 {
			o.Meta.AlsoVia = append([]string(nil), v...)
		}
	}
}

// committed looks up a recently stored observation and its row id (0 if
// only existence is known).
func (p *Pipeline) committed(o Observation) (int64, bool) {
	now := time.Now()
	k := o.ObservationKey
	if id, ok := p.recent.get(k, now); ok {
		return id, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if p.dedupe != nil {
		ids, err := p.dedupe.LookupObservations(ctx, [][16]byte{k})
		if err == nil {
			return ids[0], ids[0] != 0
		}
		p.m.CacheErrors.WithLabelValues("dedupe_check").Inc()
	}
	id, found, err := p.sink.RecentObservation(ctx, k, o.ObservedAt.Add(-p.cfg.DedupeTTL))
	if err != nil {
		return 0, false // prefer a possible duplicate (collapsed at query time) over data loss
	}
	return id, found
}

func (p *Pipeline) writer() {
	batch := make([]*Observation, 0, p.cfg.BatchSize)
	t := time.NewTicker(p.cfg.FlushEvery)
	defer t.Stop()
	for {
		select {
		case o, ok := <-p.toWriter:
			if !ok {
				p.flush(batch)
				p.flushProvenance()
				return
			}
			batch = append(batch, o)
			if len(batch) >= p.cfg.BatchSize {
				p.flush(batch)
				batch = batch[:0]
			}
		case <-t.C:
			if len(batch) > 0 {
				p.flush(batch)
				batch = batch[:0]
			}
			p.flushProvenance()
		}
	}
}

// flushProvenance applies queued late cross-broker deliveries as one
// batched UPDATE by primary key. Provenance is a debug aid: on failure the
// updates are dropped and counted rather than blocking ingestion.
func (p *Pipeline) flushProvenance() {
	p.pendMu.Lock()
	if len(p.pending) == 0 {
		p.pendMu.Unlock()
		return
	}
	work := p.pending
	p.pending = map[int64][]string{}
	p.pendMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Rows reach here through the dedupe lookup, so they are at most one
	// dedupe window old; the margin covers queueing and clock skew.
	n, err := p.sink.AddAlsoVia(ctx, work, time.Now().Add(-p.cfg.DedupeTTL-24*time.Hour))
	if err != nil {
		p.m.ProvenanceUpdates.WithLabelValues("failed").Add(float64(len(work)))
		p.log.Warn("broker provenance update failed", "rows", len(work), "err", err)
		return
	}
	p.m.ProvenanceUpdates.WithLabelValues("updated").Add(float64(n))
}

// flush commits a batch, retrying with backoff until it succeeds. While it
// retries, workers block on toWriter and the bounded queue absorbs input.
func (p *Pipeline) flush(batch []*Observation) {
	if len(batch) == 0 {
		return
	}
	// No two copies of one observation reach the writer: claim holds a key
	// in flight until afterCommit.
	uniq := batch
	backoff := 250 * time.Millisecond
	for {
		timeout := 30 * time.Second
		if p.closed.Load() {
			// Shutting down: no attempt may outlast the drain deadline, and past
			// it the rows are given up as a gap without trying (D-059).
			left := time.Until(time.Unix(0, p.stopAt.Load()).Add(p.cfg.DrainTimeout))
			if left <= 0 {
				p.giveUp(uniq, errors.New("drain deadline passed"))
				return
			}
			timeout = min(timeout, left)
		}
		p.takeAlsoVia(uniq)
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		ids, err := p.sink.InsertBatch(ctx, uniq)
		cancel()
		if err == nil {
			p.degraded.Store(false)
			p.lastOK.Store(time.Now().Unix())
			p.m.WriterLatency.Observe(time.Since(start).Seconds())
			p.m.WriterBatches.Inc()
			p.m.WriterRows.Add(float64(len(uniq)))
			p.afterCommit(uniq, ids)
			return
		}
		p.degraded.Store(true)
		p.m.WriterErrors.Inc()
		wait := backoff
		if p.closed.Load() {
			// Shutting down: retry only until the drain deadline, then give
			// the rows up as a gap rather than hang until killed.
			left := time.Until(time.Unix(0, p.stopAt.Load()).Add(p.cfg.DrainTimeout))
			if left <= 0 {
				p.giveUp(uniq, err)
				return
			}
			wait = min(wait, left)
		}
		p.log.Warn("batch insert failed; retrying", "rows", len(uniq), "err", err, "backoff", wait)
		time.Sleep(wait)
		backoff = min(backoff*2, 30*time.Second)
	}
}

// giveUp records rows the shutdown drain could not store as a gap.
func (p *Pipeline) giveUp(rows []*Observation, err error) {
	p.log.Error("database unavailable at shutdown; rows lost", "rows", len(rows), "err", err)
	p.m.Dropped.WithLabelValues("shutdown_db_unavailable").Add(float64(len(rows)))
	for _, o := range rows {
		p.noteGap(o.ObservedAt, "shutdown_db_unavailable")
	}
}

func (p *Pipeline) afterCommit(obs []*Observation, ids []int64) {
	now := time.Now()
	keys := make([][16]byte, len(obs))
	events := make([]LiveEvent, 0, len(obs))
	p.inflightMu.Lock()
	for i, o := range obs {
		k := o.ObservationKey
		keys[i] = k
		// Copies that arrived after the last takeAlsoVia but before commit
		// become row updates.
		for _, b := range p.alsoVia[k] {
			if !slices.Contains(o.Meta.AlsoVia, b) {
				p.queueProvenance(ids[i], b)
			}
		}
		brokers := append([]string{o.BrokerID}, p.alsoVia[k]...)
		p.recent.add(k, ids[i], brokers, now)
		delete(p.inflight, k)
		delete(p.alsoVia, k)
	}
	p.inflightMu.Unlock()
	for i, o := range obs {
		p.m.Accepted.WithLabelValues(o.PacketType, string(o.SignatureStatus)).Inc()
		if o.Meta.NodeInfo != nil && o.Meta.NodeInfo.KeyConflict {
			p.m.KeyConflicts.Inc()
			p.log.Warn("unsigned NodeInfo announces a key conflicting with the authoritative key", "node", protocol.NodeID(o.Source))
		}
		if o.Promote != nil && p.promote != nil {
			id := *o.Promote
			id.Since, id.RowID = o.ObservedAt, ids[i]
			p.promote.Promote(id)
		}
		if ev := toLive(o, ids[i]); ev.Row != nil {
			events = append(events, ev)
		} else {
			// Stored, but not encodable for the stream: browsers get it from
			// their next sync rather than a row-less event.
			p.m.Rejected.WithLabelValues("live_unencodable").Inc()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if p.dedupe != nil {
		if err := p.dedupe.MarkObservations(ctx, keys, ids); err != nil {
			p.m.CacheErrors.WithLabelValues("dedupe_mark").Inc()
		}
	}
	if p.pub != nil {
		p.pub.PublishLive(ctx, events)
	}
}

func toLive(o *Observation, id int64) LiveEvent {
	return LiveEvent{ID: id, T: o.ObservedAt, Row: LiveRow(o, id)}
}
