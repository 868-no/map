package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/security"
)

// ErrNoPartition marks an insert refused because no partition holds a row:
// a schema gap partition upkeep closes, so the batch is retried.
var ErrNoPartition = errors.New("no partition for the row")

// ErrUnencodable marks an observation whose row cannot be encoded for
// storage: its own data's fault, so it is refused like a row the database
// cannot hold, never retried (it would stall the writer).
var ErrUnencodable = errors.New("row cannot be encoded")

// Sink persists batches (storage package, adapted in cmd).
type Sink interface {
	// InsertBatch's error wraps ErrNoPartition when a partition is missing.
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
	// LookupObservations returns the row id per key: 0 when not seen, -1
	// when seen but the id is unknown.
	LookupObservations(ctx context.Context, keys [][16]byte) ([]int64, error)
	MarkObservations(ctx context.Context, keys [][16]byte, ids []int64, ttl time.Duration) error
}

// Publisher fans out live events (Redis pub/sub or in-process). May be nil.
// batch is a JSON array of LiveEvent, encoded once for every sink.
type Publisher interface {
	PublishLive(ctx context.Context, batch json.RawMessage)
}

// Promoter records identities after their rows commit.
type Promoter interface {
	Promote(security.Identity) bool
}

// LiveEvent announces an accepted observation to SSE clients: its row id,
// observed_at and the full compact row, identical to what /observations
// returns (D-033, D-041). Never payload bytes or envelope data.
// Row is the encoded ObsRow; the API documents it as one.
type LiveEvent struct {
	ID  int64           `json:"id"`
	T   time.Time       `json:"t"`
	Row json.RawMessage `json:"row"`
}

// EncodeLiveBatch writes events as a JSON array, as json.Marshal would but
// with each already-encoded row copied as-is rather than re-compacted.
func EncodeLiveBatch(events []LiveEvent) json.RawMessage {
	n := 2
	for _, e := range events {
		n += len(e.Row) + 64
	}
	b := make([]byte, 0, n)
	b = append(b, '[')
	for i, e := range events {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"id":`...)
		b = strconv.AppendInt(b, e.ID, 10)
		b = append(b, `,"t":"`...)
		b = e.T.AppendFormat(b, time.RFC3339Nano)
		b = append(b, `","row":`...)
		b = append(b, e.Row...)
		b = append(b, '}')
	}
	return append(b, ']')
}

// DedupeWindow: the same reception uploaded again within it (a QoS retry,
// a reconnect, another broker) is one reception.
const DedupeWindow = 15 * time.Minute

// Config sizes the pipeline.
type Config struct {
	QueueSize  int
	Workers    int
	BatchSize  int
	FlushEvery time.Duration
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

	dedupeWait    time.Duration // dedupeBackoff; shorter in tests
	dedupeRetryAt atomic.Int64  // UnixNano before which Redis dedupe is skipped
	dedupeDown    atomic.Bool   // an outage was logged
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
	return &Pipeline{
		cfg: cfg, sink: sink, dedupe: dedupe, pub: pub, promote: promote, m: m, log: log,
		queue:    make(chan RawMessage, cfg.QueueSize),
		toWriter: make(chan *Observation, cfg.BatchSize*2),
		recent:   newTTLSet(DedupeWindow, 200_000),
		inflight: map[[16]byte]string{},
		alsoVia:  map[[16]byte][]string{},
		pending:  map[int64][]string{},

		dedupeWait: dedupeBackoff,
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
	}
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
	for range p.cfg.Workers {
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
	id, found, local := p.committed(o)
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
	var cross bool
	if local {
		cross = p.recent.addBroker(k, o.BrokerID)
	} else {
		// Found in Redis or the database: whether this broker delivered it
		// before is unknown, so it is not counted as another broker's copy,
		// and the SQL keeps the row's own broker out of its provenance. Held
		// in process from now on, so later copies are not looked up again.
		p.recent.add(k, id, []string{o.BrokerID}, time.Now())
	}
	if (cross || !local) && id > 0 {
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
			o.meta, o.tail = nil, nil // encode again with it
		}
	}
}

// committed looks up a recently stored observation and its row id (-1 when
// Redis knows only that it was stored, not the row); local: found in the in-process set, which knows
// the brokers that delivered it.
func (p *Pipeline) committed(o Observation) (id int64, found, local bool) {
	now := time.Now()
	k := o.ObservationKey
	if id, ok := p.recent.get(k, now); ok {
		return id, true, true
	}
	// Ingest is a singleton: once this process has run a whole dedupe window
	// without evicting a recent key for room, every key stored within the
	// window is in the in-process set, and Redis or the database could only
	// say the same at the cost of a round trip per reception.
	if p.recent.complete(now) {
		return 0, false, false
	}
	// Past the shutdown drain's deadline every row left is given up: no
	// lookup (up to a second each, with Redis or the database down) for them.
	if left, closing := p.drainLeft(); closing && left <= 0 {
		return 0, false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if p.dedupeUp(now) {
		ids, err := p.dedupe.LookupObservations(ctx, [][16]byte{k})
		if err == nil {
			p.dedupeOK()
			return ids[0], ids[0] != 0, false
		}
		p.dedupeFailed(now, err)
		p.m.CacheErrors.WithLabelValues("dedupe_check").Inc()
	}
	id, found, err := p.sink.RecentObservation(ctx, k, o.ObservedAt.Add(-DedupeWindow))
	if err != nil {
		return 0, false, false // prefer a possible duplicate (collapsed at query time) over data loss
	}
	return id, found, false
}

// After a Redis error the dedupe index is left alone for dedupeBackoff: an
// unreachable Redis would otherwise cost every message a timeout. The
// in-process set and the database answer meanwhile (D-166).
const dedupeBackoff = 30 * time.Second

func (p *Pipeline) dedupeUp(now time.Time) bool {
	return p.dedupe != nil && now.UnixNano() >= p.dedupeRetryAt.Load()
}

func (p *Pipeline) dedupeFailed(now time.Time, err error) {
	p.dedupeRetryAt.Store(now.Add(p.dedupeWait).UnixNano())
	if p.dedupeDown.CompareAndSwap(false, true) {
		p.log.Warn("dedupe cache unavailable; checking the database instead", "err", err, "retry_every", p.dedupeWait)
	}
}

func (p *Pipeline) dedupeOK() {
	if p.dedupeDown.CompareAndSwap(true, false) {
		p.log.Info("dedupe cache available again")
	}
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
	n, err := p.sink.AddAlsoVia(ctx, work, time.Now().Add(-DedupeWindow-24*time.Hour))
	if err != nil {
		p.m.ProvenanceUpdates.WithLabelValues("failed").Add(float64(len(work)))
		p.log.Warn("broker provenance update failed", "rows", len(work), "err", err)
		return
	}
	p.m.ProvenanceUpdates.WithLabelValues("updated").Add(float64(n))
}

// Refused rows (D-165). The database refusing a row on its data (Permanent)
// looks the same as it refusing every row because it is out of step with
// them (a schema mismatch during a deploy). A refused row is therefore
// dropped only once the database has taken another row after refusing it:
// part of the same batch, found by halving it, or a row that arrived while
// the refused ones were held. Until then the rows are kept and retried as in
// an outage, with the writer degraded; at a few rows a second most batches
// hold one row, and a lone row refused must not be dropped on the spot.
const (
	// refusedPoll is the least time between attempts while held rows are
	// refused and new rows arrive to test the database with.
	refusedPoll = 250 * time.Millisecond
	// isolateEvery is how often held refused rows are halved again without
	// new evidence (2n-1 inserts), in case the database recovered while one
	// of them is refused for good and no new row arrives to show it.
	isolateEvery = time.Minute
	// warnEvery spaces out the warnings of a write that keeps failing.
	warnEvery = 30 * time.Second
)

// flush commits a batch, retrying with backoff until it succeeds. While it
// retries, workers block on toWriter and the bounded queue absorbs input.
// While the database refuses every held row, rows that arrive are taken in
// and tried on their own first: if it takes them, the held rows' refusal is
// down to their own data and they are dropped.
func (p *Pipeline) flush(batch []*Observation) {
	// No two copies of one observation reach the writer: claim holds a key
	// in flight until afterCommit.
	batch = p.encodable(batch)
	if len(batch) == 0 {
		return
	}
	backoff := 250 * time.Millisecond
	var fresh []*Observation // taken in while every held row was refused
	var isolated, warned time.Time
	for {
		// Shutting down: no attempt may outlast the drain deadline, and past
		// it the rows are given up as a gap without trying (D-059).
		timeout := 30 * time.Second
		if left, closing := p.drainLeft(); closing {
			if left <= 0 {
				p.giveUp(slices.Concat(batch, fresh), errors.New("drain deadline passed"))
				return
			}
			timeout = min(timeout, left)
		}
		accepted := false // the database took other rows since refusing these
		if fresh = p.encodable(fresh); len(fresh) > 0 {
			if p.insert(fresh, timeout) == nil {
				accepted = true
			} else {
				p.m.WriterErrors.Inc()
				batch = append(batch, fresh...) // no evidence: held with the rest
			}
			fresh = nil
		}
		err := p.insert(batch, timeout)
		if err == nil {
			return
		}
		p.m.WriterErrors.Inc()
		refusing := false
		if Permanent(err) {
			refused, again := batch, []*Observation(nil)
			if len(batch) > 1 && (accepted || time.Since(isolated) >= isolateEvery) {
				// Halve the batch until the refused rows stand alone, storing
				// the rest; that the database took some is evidence too.
				refused, again = p.isolate(batch, timeout)
				isolated = time.Now()
				accepted = accepted || len(refused)+len(again) < len(batch)
			}
			if accepted {
				for _, o := range refused {
					p.reject(o, "db_refused_row", err)
				}
				if len(again) == 0 {
					return
				}
				batch = again // retry what failed for another reason
				continue
			}
			refusing = true // every row refused: kept, as in an outage
		}
		p.degraded.Store(true)
		// Shutting down: retry only until the drain deadline, then give the
		// rows up as a gap rather than hang until killed.
		wait := backoff
		if left, closing := p.drainLeft(); closing {
			if left <= 0 {
				p.giveUp(batch, err)
				return
			}
			wait = min(wait, left)
		}
		if time.Since(warned) >= warnEvery {
			p.log.Warn("batch insert failed; retrying", "rows", len(batch), "err", err, "backoff", wait, "refused", refusing)
			warned = time.Now()
		}
		fresh = p.pause(wait, refusing, p.cfg.BatchSize-len(batch))
		backoff = min(backoff*2, 30*time.Second)
	}
}

// insert tries one insert of rows and on success completes their commit.
func (p *Pipeline) insert(rows []*Observation, timeout time.Duration) error {
	p.takeAlsoVia(rows)
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	ids, err := p.sink.InsertBatch(ctx, rows)
	cancel()
	if err != nil {
		return err
	}
	p.degraded.Store(false)
	p.m.WriterLatency.Observe(time.Since(start).Seconds())
	p.m.WriterBatches.Inc()
	p.m.WriterRows.Add(float64(len(rows)))
	p.afterCommit(rows, ids)
	return nil
}

// encodable drops the rows that cannot be encoded for storage: their own
// fault whatever the database says, so they never wait for evidence.
func (p *Pipeline) encodable(rows []*Observation) []*Observation {
	out := rows[:0]
	for _, o := range rows {
		if _, _, err := o.Encoded(); err != nil {
			p.reject(o, "unencodable_row", err)
			continue
		}
		out = append(out, o)
	}
	return out
}

// pause waits d before the next attempt. While every held row is refused
// (refusing), rows the workers hand over meanwhile, at most room of them,
// are taken in and end the wait early (after refusedPoll at least), so they
// can show soon whether the database takes rows at all.
func (p *Pipeline) pause(d time.Duration, refusing bool, room int) []*Observation {
	if !refusing || room <= 0 {
		time.Sleep(d)
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	time.Sleep(min(d, refusedPoll))
	var got []*Observation
	select {
	case <-t.C:
	case o, ok := <-p.toWriter:
		if !ok {
			<-t.C // shutting down: no more rows will come
			return nil
		}
		got = append(got, o)
	}
	for len(got) < room {
		select {
		case o, ok := <-p.toWriter:
			if !ok {
				return got
			}
			got = append(got, o)
		default:
			return got
		}
	}
	return got
}

// drainLeft is how long the shutdown drain may still take, and whether the
// pipeline is shutting down at all.
func (p *Pipeline) drainLeft() (time.Duration, bool) {
	if !p.closed.Load() {
		return 0, false
	}
	return time.Until(time.Unix(0, p.stopAt.Load()).Add(p.cfg.DrainTimeout)), true
}

// isolate inserts rows the database refused as a batch, halving until the
// rows it refuses stand alone. It commits what it can and returns the rows
// refused on their own, and those whose insert failed for another reason.
func (p *Pipeline) isolate(rows []*Observation, timeout time.Duration) (refused, again []*Observation) {
	if len(rows) > 1 {
		h := len(rows) / 2
		r1, a1 := p.isolate1(rows[:h], timeout)
		r2, a2 := p.isolate1(rows[h:], timeout)
		// Into new slices: r1 and a1 may be rows[:h] itself, whose spare
		// capacity is rows[h:], where r2 and a2 still point.
		return slices.Concat(r1, r2), slices.Concat(a1, a2)
	}
	return p.isolate1(rows, timeout)
}

// isolate1 tries one insert of rows, recursing through isolate when the
// database refuses it.
func (p *Pipeline) isolate1(rows []*Observation, timeout time.Duration) (refused, again []*Observation) {
	err := p.insert(rows, timeout)
	switch {
	case err == nil:
		return nil, nil
	case !Permanent(err):
		return nil, rows
	case len(rows) == 1:
		return rows, nil
	}
	return p.isolate(rows, timeout)
}

// Permanent reports whether a write failed on the data rather than on the
// database: a row that cannot be encoded (ErrUnencodable), SQLSTATE class 22
// (data exception, e.g. NUL in text) or 23 (integrity). A missing partition
// is also class 23 but stays retryable (ErrNoPartition). The SQLSTATE is read
// via an interface so this package does not depend on the driver.
func Permanent(err error) bool {
	if errors.Is(err, ErrUnencodable) {
		return true
	}
	var se interface{ SQLState() string }
	if !errors.As(err, &se) || errors.Is(err, ErrNoPartition) {
		return false
	}
	c := se.SQLState()
	return strings.HasPrefix(c, "22") || strings.HasPrefix(c, "23")
}

// reject drops one row that cannot be stored, counted under category, and
// releases its claim.
func (p *Pipeline) reject(o *Observation, category string, err error) {
	p.log.Warn("row cannot be stored; dropped", "broker", o.BrokerID, "topic", o.Topic, "reason", category, "err", err)
	p.m.Rejected.WithLabelValues(category).Inc()
	p.inflightMu.Lock()
	delete(p.inflight, o.ObservationKey)
	delete(p.alsoVia, o.ObservationKey)
	p.inflightMu.Unlock()
}

// giveUp counts the rows the shutdown drain could not store as dropped.
func (p *Pipeline) giveUp(rows []*Observation, err error) {
	p.log.Error("database unavailable at shutdown; rows lost", "rows", len(rows), "err", err)
	p.m.Dropped.WithLabelValues("shutdown_db_unavailable").Add(float64(len(rows)))
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
		if row, err := LiveRow(o, ids[i]); err == nil {
			events = append(events, LiveEvent{ID: ids[i], T: o.ObservedAt, Row: row})
		} else {
			// Stored, but not encodable for the stream: browsers get it from
			// their next sync rather than a row-less event.
			p.m.Rejected.WithLabelValues("live_unencodable").Inc()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if now := time.Now(); p.dedupeUp(now) {
		if err := p.dedupe.MarkObservations(ctx, keys, ids, DedupeWindow); err != nil {
			p.dedupeFailed(now, err)
			p.m.CacheErrors.WithLabelValues("dedupe_mark").Inc()
		}
	}
	if p.pub != nil && len(events) > 0 {
		p.pub.PublishLive(ctx, EncodeLiveBatch(events))
	}
}
