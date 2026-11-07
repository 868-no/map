package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
)

// ---- whole UTC days of observations, shared by every visitor (D-158..D-160) ----
//
// A rolling window starts at a different instant for every visitor, so its
// pages never coincide; the rows of a past UTC day do. Once a day can no
// longer change it is served whole, from Redis and with an immutable
// Cache-Control, so browsers, Cloudflare and the other API replicas reuse one
// database read per day and generation.

const (
	// SettleMargin: a day is final this long after it ends at the earliest
	// (late commits, D-159). Browsers use the same margin to plan.
	SettleMargin = 30 * time.Minute
	// writerEvidence: a row observed this long after the day ended shows the
	// writer committed everything observed before it (D-159).
	writerEvidence = 15 * time.Minute
	dayTTL         = 15 * 24 * time.Hour // Redis keeps a day this long: the longest window (14 days) and its first, partly covered day; older days are rebuilt when asked
	dayBuildLimit  = 2 * time.Minute     // a build outlives the request that started it, not by more than this
	// One replica builds a day; a crashed builder's lock lapses after this.
	// The build's deadline starts before the lock is taken, so a lock this
	// long outlives every build it guards.
	dayLockTTL  = dayBuildLimit
	immutableCC = "public, max-age=31536000, immutable"
	// brQuality: the brotli level of a cached day's br copy (D-168). On a
	// real 6.1 MB day level 9 took 0.8 s for 598 KB (gzip: 808 KB); level 10
	// took 9 s for 502 KB, too long to hold a read slot.
	brQuality = 9
)

// The largest compressed day built in memory (larger days stream uncached)
// and the largest stored in Redis (variables for tests).
var (
	dayMaxBytes = 64 << 20
	dayMaxRedis = 16 << 20
)

// How long a replica waits for another's build before building its own, and
// how often it looks meanwhile (variables for tests).
var (
	dayWait = 10 * time.Second
	dayPoll = 250 * time.Millisecond
)

// BlobStore is the shared day cache: Redis (cache.Client), absent when Redis
// is not configured.
type BlobStore interface {
	GetBlob(ctx context.Context, key string) ([]byte, error)
	SetBlob(ctx context.Context, key string, val []byte, ttl time.Duration) error
	Lock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	Unlock(ctx context.Context, key, token string) error
}

// rowSource is a query's rows as writeObservations writes them.
type rowSource interface {
	Each(emit func(row []byte) error) error
	More() bool
	Next() *query.Cursor
	Close()
}

// rowsDB is what the day endpoint reads from the database (an interface so
// tests can run it without one).
type rowsDB interface {
	History(ctx context.Context) (storage.HistoryState, error)
	DaySettled(ctx context.Context, day, after window.Window) (bool, error)
	Rows(ctx context.Context, w window.Window) (rowSource, error)
}

type pgRows struct{ pool *pgxpool.Pool }

func (p pgRows) History(ctx context.Context) (storage.HistoryState, error) {
	return storage.History(ctx, p.pool)
}

func (p pgRows) DaySettled(ctx context.Context, day, after window.Window) (bool, error) {
	return storage.DaySettled(ctx, p.pool, day, after)
}

func (p pgRows) Rows(ctx context.Context, w window.Window) (rowSource, error) {
	return query.OpenAll(ctx, p.pool, w)
}

func (s *Server) rowsDB() rowsDB {
	if s.db != nil {
		return s.db
	}
	return pgRows{s.Pool}
}

// generation names everything that decides what a stored row is served as:
// decoder, row format, configuration and history revision (D-041, D-158).
func (s *Server) generation(rev int64) string {
	return fmt.Sprintf("d%d.r%d.c%s.h%d", ingest.DecodeVersion, obsrow.Version, s.ConfigRev, rev)
}

type DayInput struct {
	Date           string `path:"date" pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}$" doc:"UTC day, YYYY-MM-DD" example:"2026-11-01"`
	Generation     string `query:"generation" required:"true" doc:"The generation the client holds (from /observations); another one is answered 409 with the current one"`
	IfNoneMatch    string `header:"If-None-Match" doc:"ETag of a copy held; 304 when it is still the day's rows"`
	AcceptEncoding string `header:"Accept-Encoding"`
}

// DayOutput is streamed (from the cached compressed body or the database);
// its schema is ObservationsBody, declared on the operation.
type DayOutput struct {
	Body func(huma.Context)
}

// dayPlan is what a requested day covers, decided from the clock alone.
type dayPlan struct {
	day   window.Window // [00:00, 24:00) UTC
	rows  window.Window // what is served: the day within retention and before now
	after window.Window // where a row proves the writer got past the day
	final bool          // by time and retention, the day can no longer change
}

// planDay places a UTC day against the clock and the retention cutoff. A day
// is final once it ended SettleMargin ago and lies wholly within retention:
// a day the cutoff cuts into loses rows at the next retention run (D-160).
func planDay(date, now, cutoff time.Time) (dayPlan, error) {
	start := date.UTC()
	end := start.Add(24 * time.Hour)
	if !start.Before(now) {
		return dayPlan{}, huma.Error400BadRequest("date: the day has not begun")
	}
	if !end.After(cutoff) {
		return dayPlan{}, huma.Error400BadRequest("date: before the retention limit")
	}
	p := dayPlan{day: window.Window{Start: start, End: end}, rows: window.Window{Start: start, End: end},
		after: window.Window{Start: end.Add(writerEvidence), End: now}}
	if p.rows.Start.Before(cutoff) {
		p.rows.Start = cutoff
	}
	if p.rows.End.After(now) {
		p.rows.End = now
	}
	p.final = !start.Before(cutoff) && !now.Before(end.Add(SettleMargin))
	return p, nil
}

// dayResult is a built day: its body gzip- and brotli-compressed (br is nil
// for a copy stored before D-168), and whether it is the day's final content
// (cacheable everywhere).
type dayResult struct {
	gz, br    []byte
	immutable bool
	tooLarge  bool // over dayMaxBytes compressed: stream it from the database instead
	unsettled bool // not final yet (D-159): stream it, nothing to build or hold
}

func (s *Server) dayCount(result string) {
	if s.Metrics != nil {
		s.Metrics.DayRequests.WithLabelValues(result).Inc()
	}
}

func (s *Server) cacheError(op string, err error) {
	if s.Metrics != nil {
		s.Metrics.CacheErrors.WithLabelValues(op).Inc()
	}
	if s.Log != nil {
		s.Log.Debug("day cache", "op", op, "err", err)
	}
}

func (s *Server) observationsDay(ctx context.Context, in *DayInput) (*DayOutput, error) {
	date, err := time.Parse(time.DateOnly, in.Date)
	if err != nil {
		return nil, huma.Error400BadRequest("date: not a day (YYYY-MM-DD)")
	}
	b := s.Bounds()
	p, err := planDay(date, b.Now, b.Cutoff)
	if err != nil {
		return nil, err
	}
	db := s.rowsDB()
	st, err := db.History(ctx)
	if err != nil {
		return nil, err
	}
	gen := s.generation(st.Rev)
	if in.Generation != gen {
		// Never store a URL's answer under another generation's name.
		return nil, huma.ErrorWithHeaders(huma.Error409Conflict("generation: the server's has changed; discard rows of the old one",
			&huma.ErrorDetail{Message: "current generation", Location: "query.generation", Value: gen}),
			http.Header{"Cache-Control": {"no-store"}})
	}
	final := p.final && !st.Importing
	gz, br := accepts(in.AcceptEncoding, "gzip", "x-gzip"), accepts(in.AcceptEncoding, "br")
	if final && etagMatch(in.IfNoneMatch, gen, in.Date) {
		s.dayCount("not_modified")
		// Every encoding holds the same rows, so any held tag matches; the
		// 304 names the representation a 200 would send this client.
		enc := ""
		switch {
		case br:
			enc = "br"
		case gz:
			enc = "gzip"
		}
		return &DayOutput{Body: func(hc huma.Context) {
			dayHeaders(hc, true, dayETag(gen, in.Date, enc))
			hc.SetStatus(http.StatusNotModified)
		}}, nil
	}
	head := ObservationsBody{Window: WindowEcho{Start: p.day.Start, End: p.day.End}, Since: p.rows.Start, Until: p.rows.End, Generation: gen}
	if !final {
		// Not final by the clock (today, the retention edge) or importing:
		// nothing to share, so nothing is held whole; streamed as read.
		s.dayCount("uncached")
		return s.streamDay(ctx, db, p, head, gz)
	}
	key := "meshmap:obsday:" + gen + ":" + in.Date
	if _, large := s.dayLarge.Load(key); large {
		// Built once already and found too large to hold: a build would
		// only be thrown away again.
		s.dayCount("large")
		return s.streamDay(ctx, db, p, head, gz)
	}
	if until, ok := s.unsettled.Load(key); ok && s.now().Before(until.(time.Time)) {
		// Found not settled a moment ago: streamed without the cache lookups,
		// the lock and a read slot for the check (while a redecode runs, every
		// day with stale rows is asked for this way).
		s.dayCount("uncached")
		return s.streamDay(ctx, db, p, head, gz)
	}
	res, err := s.sharedDay(ctx, db, p, head, st, key, br)
	if err != nil {
		return nil, err
	}
	if res.unsettled {
		// Rows still to be decoded again, or the writer not past the day yet.
		s.noteUnsettled(key)
		s.dayCount("uncached")
		return s.streamDay(ctx, db, p, head, gz)
	}
	if res.tooLarge {
		// Too large to hold: written from the database like a page, from
		// now on without trying to build it first.
		s.noteLargeDay(key)
		return s.streamDay(ctx, db, p, head, gz)
	}
	// br before gzip; a copy stored without br goes out as gzip.
	enc, body := "", res.gz
	switch {
	case br && res.br != nil:
		enc, body = "br", res.br
	case gz:
		enc = "gzip"
	}
	return &DayOutput{Body: func(hc huma.Context) {
		dayHeaders(hc, res.immutable, dayETag(gen, in.Date, enc))
		dst, done := stallGuard(hc)
		defer done()
		if enc != "" {
			hc.SetHeader("Content-Encoding", enc)
			hc.SetHeader("Content-Length", strconv.Itoa(len(body)))
			// In chunks: the stall guard moves the deadline per write, so one
			// write of the whole body would give a slow client stallLimit for
			// all of it rather than for each stall.
			for off := 0; off < len(body); off += writeChunk {
				if _, err := dst.Write(body[off:min(off+writeChunk, len(body))]); err != nil {
					return
				}
			}
			return
		}
		zr, err := gzip.NewReader(bytes.NewReader(res.gz))
		if err == nil {
			_, err = io.Copy(dst, zr)
		}
		if err != nil {
			s.Log.Warn("day stream aborted", "err", err)
			panic(http.ErrAbortHandler)
		}
	}}, nil
}

// noteLargeDay remembers a final day whose build outgrew dayMaxBytes, so
// this process streams it from then on instead of building (and discarding)
// it per request. Bounded: a process sees few such days, but each
// generation renames them.
// unsettledFor: how long a day found not settled is streamed without asking
// again; writeChunk: the most a cached day's body is written at once.
const (
	unsettledFor = time.Minute
	writeChunk   = 128 << 10
)

// noteUnsettled remembers, for unsettledFor, that a final day is not settled
// yet. The keys are few (a day each, per generation); expired ones are
// dropped as new ones are noted.
func (s *Server) noteUnsettled(key string) {
	now := s.now()
	s.unsettled.Range(func(k, v any) bool {
		if !now.Before(v.(time.Time)) {
			s.unsettled.Delete(k)
		}
		return true
	})
	s.unsettled.Store(key, now.Add(unsettledFor))
}

func (s *Server) noteLargeDay(key string) {
	if _, known := s.dayLarge.LoadOrStore(key, struct{}{}); known {
		return // every request that shared the build notes it: count it once
	}
	if s.dayLargeN.Add(1) > 1024 {
		s.dayLarge.Clear()
		s.dayLargeN.Store(0)
		s.dayLarge.Store(key, struct{}{})
	}
}

// streamDay writes a day's rows from the database as they are read, never
// held whole, compressed on the fly when the client takes gzip. Errors up to
// the first row still get a proper status; later ones cut the response.
func (s *Server) streamDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, gz bool) (*DayOutput, error) {
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	src, err := db.Rows(ctx, p.rows)
	if err != nil {
		release()
		return nil, err
	}
	return &DayOutput{Body: func(hc huma.Context) {
		defer release()
		defer src.Close()
		dayHeaders(hc, false, "")
		head.Now = s.now()
		dst, done := stallGuard(hc)
		defer done()
		var zw *gzip.Writer
		if gz {
			hc.SetHeader("Content-Encoding", "gzip")
			zw = gzip.NewWriter(dst)
			dst = zw
		}
		err := writeObservations(dst, head, src, nil)
		if err == nil && zw != nil {
			err = zw.Close()
		}
		if err != nil {
			s.Log.Warn("day stream aborted", "err", err)
			panic(http.ErrAbortHandler)
		}
	}}, nil
}

// stallLimit is how long one write of a response body may wait on the client.
const stallLimit = 30 * time.Second

// stallGuard wraps hc's body writer in a stallWriter, and returns the
// function that lifts the deadline again once the body is written (the
// connection may serve another request). A body holding a read slot, a
// database connection or a large buffer is held for as long as the client
// takes: the request's own deadline cancels its query but cannot unblock a
// write to a client that stopped reading, which this does.
func stallGuard(hc huma.Context) (io.Writer, func()) {
	w := hc.BodyWriter()
	rw, ok := w.(http.ResponseWriter)
	if !ok {
		return w, func() {}
	}
	rc := http.NewResponseController(rw)
	return stallWriter{w, rc}, func() { _ = rc.SetWriteDeadline(time.Time{}) }
}

// stallWriter moves the connection's write deadline stallLimit ahead before
// each write: a write that waits longer on the client fails, ending the
// response. A slow client that keeps reading is limited only by the
// request's deadline.
type stallWriter struct {
	w  io.Writer
	rc *http.ResponseController
}

func (s stallWriter) Write(b []byte) (int, error) {
	_ = s.rc.SetWriteDeadline(time.Now().Add(stallLimit)) // unsupported: no limit, as before
	return s.w.Write(b)
}

func dayHeaders(hc huma.Context, immutable bool, etag string) {
	hc.SetHeader("Content-Type", "application/json")
	hc.SetHeader("Vary", "Accept-Encoding")
	if immutable {
		hc.SetHeader("Cache-Control", immutableCC)
		hc.SetHeader("ETag", etag)
	} else {
		hc.SetHeader("Cache-Control", "no-store")
	}
}

// sharedDay answers a final day from Redis, or builds it once: one build per
// process at a time (singleflight) and, through a short Redis lock, one
// across replicas, whose others wait for its result a little while before
// building their own. Without Redis every process builds its own.
func (s *Server) sharedDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, st storage.HistoryState, key string, br bool) (*dayResult, error) {
	if s.DayCache != nil {
		switch res, err := s.storedDay(ctx, key, br, false); {
		case err != nil:
			s.cacheError("day_get", err)
		case res != nil && res.tooLarge:
			s.dayCount("large")
			return res, nil
		case res != nil:
			s.dayCount("hit")
			return res, nil
		}
	}
	ch := s.dayFlight.DoChan(key, func() (any, error) {
		// Detached from the request that started it: others may be waiting
		// for the result, and a finished build is stored for the next.
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dayBuildLimit)
		defer cancel()
		return s.fillDay(bctx, db, p, head, st, key)
	})
	select {
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		return r.Val.(*dayResult), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Server) fillDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, st storage.HistoryState, key string) (*dayResult, error) {
	if c := s.DayCache; c != nil {
		lock, token := key+":lock", rand.Text()
		held, err := c.Lock(ctx, lock, token, dayLockTTL)
		if err != nil {
			s.cacheError("day_lock", err)
		}
		// Another replica builds it: wait for its result while the lock is held.
		for wait := time.Now().Add(dayWait); err == nil && !held && time.Now().Before(wait); {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(dayPoll):
			}
			var res *dayResult
			if res, err = s.storedDay(ctx, key, true, true); err == nil && res != nil {
				s.dayCount("waited")
				return res, nil
			}
			if err == nil {
				held, err = c.Lock(ctx, lock, token, dayLockTTL) // free again: its build was not cacheable, or failed
			}
		}
		if held {
			defer func() {
				if err := c.Unlock(context.WithoutCancel(ctx), lock, token); err != nil {
					s.cacheError("day_unlock", err)
				}
			}()
			// Stored between our last look and taking the lock.
			if res, err := s.storedDay(ctx, key, true, true); err == nil && res != nil {
				s.dayCount("waited")
				return res, nil
			}
		}
	}
	res, err := s.buildDay(ctx, db, p, head, st)
	switch {
	case err != nil, res.unsettled: // counted by the caller, which streams it
	case res.tooLarge:
		s.dayCount("large")
	default:
		s.dayCount("built")
	}
	if err == nil && res.tooLarge && s.DayCache != nil {
		// Tell the other replicas, whose waiters would build it next.
		if err := s.DayCache.SetBlob(ctx, key+":large", []byte{1}, dayTTL); err != nil {
			s.cacheError("day_set", err)
		}
	}
	if err != nil || !res.immutable || res.tooLarge || s.DayCache == nil || len(res.gz) > dayMaxRedis {
		return res, err
	}
	// The br copy first: the gzip copy marks the day as stored.
	if len(res.br) <= dayMaxRedis {
		if err := s.DayCache.SetBlob(ctx, key+":br", res.br, dayTTL); err != nil {
			s.cacheError("day_set", err)
		}
	}
	if err := s.DayCache.SetBlob(ctx, key, res.gz, dayTTL); err != nil {
		s.cacheError("day_set", err)
	}
	return res, nil
}

// storedDay reads a day from Redis, nil when it is not there. br: a br copy
// (key + ":br") serves the caller; gz: the gzip copy is needed as well (a
// result shared with callers that may not take br). A br copy is stored only
// for a finished build, before its gzip copy, so either marks the day as
// stored; a day stored before D-168 has no br copy and goes out as gzip.
func (s *Server) storedDay(ctx context.Context, key string, br, gz bool) (*dayResult, error) {
	res := &dayResult{immutable: true}
	if br {
		var err error
		if res.br, err = s.DayCache.GetBlob(ctx, key+":br"); err != nil {
			s.cacheError("day_get", err)
		}
		if res.br != nil && !gz {
			return res, nil
		}
	}
	z, err := s.DayCache.GetBlob(ctx, key)
	if err != nil {
		return nil, err
	}
	if z == nil {
		// Not stored: perhaps because a replica found it too large to build.
		if large, err := s.DayCache.GetBlob(ctx, key+":large"); err != nil || large == nil {
			return nil, err
		}
		return &dayResult{tooLarge: true}, nil
	}
	res.gz = z
	return res, nil
}

// errTooLarge stops a build that outgrew dayMaxBytes.
var errTooLarge = errors.New("day too large to hold")

type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errTooLarge
	}
	return b.Buffer.Write(p)
}

// buildDay reads a day final by the clock from the database into a
// compressed body, under a heavy-read slot, once the day is settled: no row
// awaiting a new decoding and the writer past it (D-159); otherwise it
// builds nothing and reports it unsettled. The body is immutable unless an
// import started or ended while it was read.
func (s *Server) buildDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, st storage.HistoryState) (*dayResult, error) {
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	settled, err := db.DaySettled(ctx, p.day, p.after)
	if err != nil {
		return nil, err
	}
	if !settled {
		// Nothing built would be stored: building both encodings (brotli at
		// quality 9) for one request, again for the next, is left to the
		// stream, which compresses as it reads.
		return &dayResult{unsettled: true}, nil
	}
	src, err := db.Rows(ctx, p.rows)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	head.Now = s.now()
	// Both copies are compressed in the one pass over the rows (D-168).
	gzBuf, brBuf := &cappedBuffer{max: dayMaxBytes}, &cappedBuffer{max: dayMaxBytes}
	zw := gzip.NewWriter(gzBuf)
	bw := brotli.NewWriterOptions(brBuf, brotli.WriterOptions{Quality: brQuality, LGWin: 22})
	err = writeObservations(io.MultiWriter(zw, bw), head, src, nil)
	if err == nil {
		err = zw.Close()
	}
	if err == nil {
		err = bw.Close()
	}
	if errors.Is(err, errTooLarge) {
		return &dayResult{tooLarge: true}, nil
	}
	if err != nil {
		return nil, err
	}
	// An import that began (or ended) while the rows were read changes the
	// revision or holds the lock: then this copy is not final.
	now, err := db.History(ctx)
	return &dayResult{gz: gzBuf.Bytes(), br: brBuf.Bytes(), immutable: err == nil && now == st}, nil
}

// dayETag is the strong validator of a day's final body; each encoding ("",
// "gzip" or "br") is its own representation, so it gets its own tag.
func dayETag(gen, date, enc string) string {
	suffix := map[string]string{"gzip": ".gz", "br": ".br"}[enc]
	return `"` + gen + "." + date + suffix + `"`
}

// etagMatch reports whether If-None-Match names this day's body in any
// encoding (all hold the same rows) or is "*".
func etagMatch(header, gen, date string) bool {
	for t := range strings.SplitSeq(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == "*" || t == dayETag(gen, date, "") || t == dayETag(gen, date, "gzip") || t == dayETag(gen, date, "br") {
			return true
		}
	}
	return false
}

// accepts reports whether Accept-Encoding allows a coding (by any of its
// names), without q=0: by naming it, or else by "*" (any coding not named).
// A coding named with q=0 is refused whatever "*" says (RFC 9110 §12.5.3).
func accepts(header string, names ...string) bool {
	named, star := false, false
	for part := range strings.SplitSeq(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		isName := slices.Contains(names, coding)
		if !isName && coding != "*" {
			continue
		}
		q := 1.0
		for p := range strings.SplitSeq(params, ";") {
			if k, v, ok := strings.Cut(strings.TrimSpace(p), "="); ok && strings.EqualFold(strings.TrimSpace(k), "q") {
				if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = f
				}
			}
		}
		switch {
		case isName && q > 0:
			return true
		case isName:
			named = true
		default:
			star = star || q > 0
		}
	}
	return star && !named
}
