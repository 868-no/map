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
	"strconv"
	"strings"
	"time"

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
	dayTTL         = 8 * 24 * time.Hour // Redis keeps a day this long: rolling windows reach back 8 days; older days are rebuilt when asked
	dayMaxBytes    = 64 << 20           // largest compressed day built in memory; larger days stream uncached
	dayMaxRedis    = 16 << 20           // largest compressed day stored in Redis
	dayBuildLimit  = 2 * time.Minute    // a build outlives the request that started it, not by more than this
	// One replica builds a day; a crashed builder's lock lapses after this.
	// The build's deadline starts before the lock is taken, so a lock this
	// long outlives every build it guards.
	dayLockTTL  = dayBuildLimit
	immutableCC = "public, max-age=31536000, immutable"
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

// dayResult is a built day: its body gzip-compressed, and whether it is the
// day's final content (cacheable everywhere).
type dayResult struct {
	gz        []byte
	immutable bool
	tooLarge  bool // over dayMaxBytes compressed: stream it from the database instead
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
	gz := acceptsGzip(in.AcceptEncoding)
	tag := dayETag(gen, in.Date, gz)
	if final && etagMatch(in.IfNoneMatch, gen, in.Date) {
		s.dayCount("not_modified")
		return &DayOutput{Body: func(hc huma.Context) {
			dayHeaders(hc, true, tag)
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
	res, err := s.sharedDay(ctx, db, p, head, st, "meshmap:obsday:"+gen+":"+in.Date)
	if err != nil {
		return nil, err
	}
	if res.tooLarge {
		// Too large to hold: written from the database like a page.
		return s.streamDay(ctx, db, p, head, gz)
	}
	return &DayOutput{Body: func(hc huma.Context) {
		dayHeaders(hc, res.immutable, tag)
		if gz {
			hc.SetHeader("Content-Encoding", "gzip")
			hc.SetHeader("Content-Length", strconv.Itoa(len(res.gz)))
			_, _ = hc.BodyWriter().Write(res.gz)
			return
		}
		zr, err := gzip.NewReader(bytes.NewReader(res.gz))
		if err == nil {
			_, err = io.Copy(hc.BodyWriter(), zr)
		}
		if err != nil {
			s.Log.Warn("day stream aborted", "err", err)
			panic(http.ErrAbortHandler)
		}
	}}, nil
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
		var dst io.Writer = hc.BodyWriter()
		if rw, ok := dst.(http.ResponseWriter); ok {
			// The read slot and the database connection are held for as long
			// as the client takes: one that stops reading for stallLimit ends
			// the stream and frees them.
			rc := http.NewResponseController(rw)
			defer func() { _ = rc.SetWriteDeadline(time.Time{}) }() // the connection may serve another request
			dst = stallWriter{dst, rc}
		}
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

// stallLimit is how long one write of a streamed day may wait on the client.
const stallLimit = 30 * time.Second

// stallWriter moves the connection's write deadline stallLimit ahead before
// each write, so a slow client still gets the whole day but a stalled one
// does not hold the stream open.
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
func (s *Server) sharedDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, st storage.HistoryState, key string) (*dayResult, error) {
	if s.DayCache != nil {
		switch b, err := s.DayCache.GetBlob(ctx, key); {
		case err != nil:
			s.cacheError("day_get", err)
		case b != nil:
			s.dayCount("hit")
			return &dayResult{gz: b, immutable: true}, nil
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
			var b []byte
			if b, err = c.GetBlob(ctx, key); err == nil && b != nil {
				s.dayCount("waited")
				return &dayResult{gz: b, immutable: true}, nil
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
			if b, err := c.GetBlob(ctx, key); err == nil && b != nil {
				s.dayCount("waited")
				return &dayResult{gz: b, immutable: true}, nil
			}
		}
	}
	s.dayCount("built")
	res, err := s.buildDay(ctx, db, p, head, st)
	if err != nil || !res.immutable || res.tooLarge || s.DayCache == nil || len(res.gz) > dayMaxRedis {
		return res, err
	}
	if err := s.DayCache.SetBlob(ctx, key, res.gz, dayTTL); err != nil {
		s.cacheError("day_set", err)
	}
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
// compressed body, under a heavy-read slot. It is immutable when it may be:
// the day had no row awaiting a new decoding, the writer was past it, and no
// import started or ended while it was read (D-159).
func (s *Server) buildDay(ctx context.Context, db rowsDB, p dayPlan, head ObservationsBody, st storage.HistoryState) (*dayResult, error) {
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	immutable, err := db.DaySettled(ctx, p.day, p.after)
	if err != nil {
		return nil, err
	}
	src, err := db.Rows(ctx, p.rows)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	head.Now = s.now()
	buf := &cappedBuffer{max: dayMaxBytes}
	zw := gzip.NewWriter(buf)
	if err := writeObservations(zw, head, src, nil); err != nil {
		if errors.Is(err, errTooLarge) {
			return &dayResult{tooLarge: true}, nil
		}
		return nil, err
	}
	if err := zw.Close(); err != nil {
		if errors.Is(err, errTooLarge) {
			return &dayResult{tooLarge: true}, nil
		}
		return nil, err
	}
	if immutable {
		// An import that began (or ended) while the rows were read changes
		// the revision or holds the lock: then this copy is not final.
		now, err := db.History(ctx)
		immutable = err == nil && now == st
	}
	return &dayResult{gz: buf.Bytes(), immutable: immutable}, nil
}

// dayETag is the strong validator of a day's final body; the compressed and
// plain bodies are different representations, so they get different tags.
func dayETag(gen, date string, gz bool) string {
	if gz {
		return `"` + gen + "." + date + `.gz"`
	}
	return `"` + gen + "." + date + `"`
}

// etagMatch reports whether If-None-Match names this day's body in either
// encoding (both hold the same rows) or is "*".
func etagMatch(header, gen, date string) bool {
	for t := range strings.SplitSeq(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == "*" || t == dayETag(gen, date, false) || t == dayETag(gen, date, true) {
			return true
		}
	}
	return false
}

// acceptsGzip reports whether Accept-Encoding allows gzip, without q=0: by
// naming it, or else by "*" (any coding not named). A gzip named with q=0
// is refused whatever "*" says (RFC 9110 §12.5.3).
func acceptsGzip(header string) bool {
	named, star := false, false
	for part := range strings.SplitSeq(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		if coding != "gzip" && coding != "x-gzip" && coding != "*" {
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
		case coding != "*" && q > 0:
			return true
		case coding != "*":
			named = true
		default:
			star = star || q > 0
		}
	}
	return star && !named
}
