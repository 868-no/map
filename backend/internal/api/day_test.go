package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/andybalholm/brotli"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
)

func TestPlanDay(t *testing.T) {
	day := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 5, 3, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		date   time.Time
		now    time.Time
		final  bool
		bad    bool
		rowsLo time.Time
		rowsHi time.Time
	}{
		{"today", day, day.Add(14 * time.Hour), false, false, day, day.Add(14 * time.Hour)},
		{"just ended", day, day.Add(24*time.Hour + 20*time.Minute), false, false, day, day.Add(24 * time.Hour)},
		{"settled", day, day.Add(24*time.Hour + SettleMargin), true, false, day, day.Add(24 * time.Hour)},
		{"long past", day, day.Add(30 * 24 * time.Hour), true, false, day, day.Add(24 * time.Hour)},
		{"not begun", day, day.Add(-time.Second), false, true, time.Time{}, time.Time{}},
		{"starts now", day, day, false, true, time.Time{}, time.Time{}},
		// The cutoff cuts into the day: served from the cutoff, never final.
		{"cut by retention", time.Date(2026, 5, 3, 0, 0, 0, 0, time.UTC), day, false, false, cutoff, time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)},
		{"wholly expired", time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC), day, false, true, time.Time{}, time.Time{}},
	}
	for _, c := range cases {
		p, err := planDay(c.date, c.now, cutoff)
		if (err != nil) != c.bad {
			t.Errorf("%s: err %v", c.name, err)
			continue
		}
		if c.bad {
			continue
		}
		if p.final != c.final || !p.rows.Start.Equal(c.rowsLo) || !p.rows.End.Equal(c.rowsHi) {
			t.Errorf("%s: final %v rows [%s, %s)", c.name, p.final, p.rows.Start, p.rows.End)
		}
		if !p.day.End.Equal(c.date.Add(24*time.Hour)) || !p.after.Start.Equal(p.day.End.Add(writerEvidence)) || !p.after.End.Equal(c.now) {
			t.Errorf("%s: day %v after %v", c.name, p.day, p.after)
		}
	}
}

func TestAcceptsAndETags(t *testing.T) {
	for h, want := range map[string]bool{
		"": false, "gzip": true, "br, gzip;q=0.5": true, "gzip;q=0": false, "identity": false, "*": true, "zstd, GZIP": true, "gzip; q=0.000": false,
		"x-gzip": true,
		// gzip named with q=0 is refused, whatever "*" allows, in either order.
		"gzip;q=0, *": false, "*, gzip;q=0": false, "*;q=0": false, "identity, *;q=0.5": true, "*;q=0, gzip": true,
	} {
		if accepts(h, "gzip", "x-gzip") != want {
			t.Errorf("accepts(%q, gzip) != %v", h, want)
		}
	}
	for h, want := range map[string]bool{
		"": false, "br": true, "gzip, deflate, br, zstd": true, "BR;q=0.1": true, "gzip": false, "br;q=0": false,
		"br;q=0, *": false, "*": true, "gzip, *;q=0": false, "brotli": false,
	} {
		if accepts(h, "br") != want {
			t.Errorf("accepts(%q, br) != %v", h, want)
		}
	}
	plain, gz, br := dayETag("g", "2026-11-03", ""), dayETag("g", "2026-11-03", "gzip"), dayETag("g", "2026-11-03", "br")
	if plain == gz || gz == br || plain == br {
		t.Fatal("encodings must have their own validators")
	}
	for h, want := range map[string]bool{plain: true, gz: true, br: true, "W/" + gz: true, `"x", ` + plain: true, "*": true, `"g.2026-11-02"`: false, "": false} {
		if etagMatch(h, "g", "2026-11-03") != want {
			t.Errorf("etagMatch(%q) != %v", h, want)
		}
	}
}

// ---- the endpoint against a fake database and Redis ----

type fakeRows struct {
	mu        sync.Mutex
	state     storage.HistoryState
	during    *storage.HistoryState // the state after the rows were read, when it changes meanwhile
	settled   bool
	rows      []string
	reads     atomic.Int32
	settledQs atomic.Int32
	gate      chan struct{} // when set, reads wait for it to close
}

func (f *fakeRows) History(context.Context) (storage.HistoryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, nil
}

func (f *fakeRows) DaySettled(context.Context, window.Window, window.Window) (bool, error) {
	f.settledQs.Add(1)
	return f.settled, nil
}

func (f *fakeRows) Rows(context.Context, window.Window) (rowSource, error) {
	f.reads.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.during != nil {
		f.state = *f.during
	}
	return &fakeSource{rows: f.rows}, nil
}

type fakeSource struct{ rows []string }

func (s *fakeSource) Each(emit func([]byte) error) error {
	for _, r := range s.rows {
		if err := emit([]byte(r)); err != nil {
			return err
		}
	}
	return nil
}
func (s *fakeSource) More() bool          { return false }
func (s *fakeSource) Next() *query.Cursor { return nil }
func (s *fakeSource) Close()              {}

type fakeBlobs struct {
	mu    sync.Mutex
	vals  map[string][]byte
	locks map[string]string
	sets  int
}

func newBlobs() *fakeBlobs { return &fakeBlobs{vals: map[string][]byte{}, locks: map[string]string{}} }

func (b *fakeBlobs) GetBlob(_ context.Context, k string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.vals[k], nil
}

func (b *fakeBlobs) SetBlob(_ context.Context, k string, v []byte, _ time.Duration) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.vals[k] = v
	b.sets++
	return nil
}

func (b *fakeBlobs) Lock(_ context.Context, k, token string, _ time.Duration) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.locks[k]; ok {
		return false, nil
	}
	b.locks[k] = token
	return true, nil
}

func (b *fakeBlobs) Unlock(_ context.Context, k, token string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.locks[k] == token {
		delete(b.locks, k)
	}
	return nil
}

var (
	testDay = "2026-11-03"
	testNow = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
)

func dayServer(t *testing.T, db *fakeRows, blobs BlobStore) (*Server, http.Handler) {
	t.Helper()
	s := &Server{Env: config.Env{RetentionMonths: 6, DefaultWindowHours: 72, MaxWindowHours: 168, LiveQuantum: 10 * time.Second},
		ConfigRev: "t", Log: slog.New(slog.DiscardHandler), Now: func() time.Time { return testNow }, db: db}
	if blobs != nil {
		s.DayCache = blobs
	}
	mux := http.NewServeMux()
	s.NewHandler(mux)
	return s, mux
}

func getDay(h http.Handler, date, gen string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/observations/day/"+date+"?generation="+gen, nil)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// decoded is a 200 answer's body undone from its Content-Encoding.
func decoded(t *testing.T, w *httptest.ResponseRecorder) io.Reader {
	t.Helper()
	body := bytes.NewReader(w.Body.Bytes())
	switch enc := w.Header().Get("Content-Encoding"); enc {
	case "gzip":
		zr, err := gzip.NewReader(body)
		if err != nil {
			t.Fatal(err)
		}
		return zr
	case "br":
		return brotli.NewReader(body)
	case "":
		return body
	default:
		t.Fatalf("Content-Encoding %q", enc)
		return nil
	}
}

// dayBody decodes a 200 answer, compressed or not.
func dayBody(t *testing.T, w *httptest.ResponseRecorder) (head ObservationsBody, rows []json.RawMessage) {
	t.Helper()
	r := decoded(t, w)
	var body struct {
		ObservationsBody
		Rows []json.RawMessage `json:"rows"`
	}
	if err := json.NewDecoder(r).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.ObservationsBody, body.Rows
}

func TestDayGenerationMismatch(t *testing.T) {
	db := &fakeRows{state: storage.HistoryState{Rev: 3}, settled: true}
	s, h := dayServer(t, db, newBlobs())
	w := getDay(h, testDay, "d0.r0.cold.h0", nil)
	if w.Code != http.StatusConflict || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("got %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if !strings.Contains(w.Body.String(), s.generation(3)) || db.reads.Load() != 0 {
		t.Fatalf("409 must name the current generation and read nothing: %s", w.Body.String())
	}
	if w := getDay(h, testDay, "", nil); w.Code != http.StatusUnprocessableEntity && w.Code != http.StatusBadRequest {
		t.Fatalf("missing generation: %d", w.Code)
	}
}

func TestDayFinalIsCachedEverywhere(t *testing.T) {
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`, `{"i":2,"t":2}`}}
	blobs := newBlobs()
	s, h := dayServer(t, db, blobs)
	gen := s.generation(0)
	w := getDay(h, testDay, gen, map[string]string{"Accept-Encoding": "gzip"})
	if w.Code != 200 || w.Header().Get("Cache-Control") != immutableCC || w.Header().Get("Content-Encoding") != "gzip" ||
		w.Header().Get("ETag") != dayETag(gen, testDay, "gzip") || w.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("got %d %v", w.Code, w.Header())
	}
	head, rows := dayBody(t, w)
	if len(rows) != 2 || head.Generation != gen || head.Window.Start.Format(time.DateOnly) != testDay || head.Window.Rolling ||
		!head.Until.Equal(head.Window.End) || head.Window.End.Sub(head.Window.Start) != 24*time.Hour {
		t.Fatalf("head %+v rows %d", head, len(rows))
	}
	if blobs.sets != 2 { // the gzip and br copies
		t.Fatalf("stored %d times", blobs.sets)
	}
	// The next visitor, without gzip, is served from Redis, decompressed.
	w = getDay(h, testDay, gen, nil)
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || w.Header().Get("ETag") != dayETag(gen, testDay, "") {
		t.Fatalf("got %d %v", w.Code, w.Header())
	}
	if _, rows := dayBody(t, w); len(rows) != 2 || db.reads.Load() != 1 {
		t.Fatalf("rows %d, database reads %d", len(rows), db.reads.Load())
	}
	// A browser revalidating its copy (either encoding's tag).
	for _, tag := range []string{dayETag(gen, testDay, "gzip"), dayETag(gen, testDay, "")} {
		w = getDay(h, testDay, gen, map[string]string{"If-None-Match": tag, "Accept-Encoding": "gzip"})
		if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != immutableCC {
			t.Fatalf("revalidation: %d %v", w.Code, w.Header())
		}
	}
	if db.reads.Load() != 1 {
		t.Fatalf("database reads %d", db.reads.Load())
	}
}

// A final day goes out as br when the client takes it, else gzip, else
// plain; each with its own tag and the same JSON (D-168).
func TestDayEncodings(t *testing.T) {
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`, `{"i":2,"t":2}`}}
	blobs := newBlobs()
	s, h := dayServer(t, db, blobs)
	gen := s.generation(0)
	var want []byte
	for _, c := range []struct{ accept, enc string }{
		{"gzip, deflate, br, zstd", "br"},
		{"br", "br"},
		{"gzip", "gzip"},
		{"br;q=0, gzip", "gzip"},
		{"br, gzip;q=0", "br"},
		{"br;q=0, gzip;q=0", ""},
		{"*", "br"},
		{"identity", ""},
		{"", ""},
	} {
		w := getDay(h, testDay, gen, map[string]string{"Accept-Encoding": c.accept})
		if w.Code != 200 || w.Header().Get("Content-Encoding") != c.enc || w.Header().Get("ETag") != dayETag(gen, testDay, c.enc) ||
			w.Header().Get("Vary") != "Accept-Encoding" || w.Header().Get("Cache-Control") != immutableCC {
			t.Fatalf("%q: got %d %v", c.accept, w.Code, w.Header())
		}
		got, err := io.ReadAll(decoded(t, w))
		if err != nil {
			t.Fatalf("%q: %v", c.accept, err)
		}
		if want == nil {
			want = got
		} else if !bytes.Equal(got, want) {
			t.Fatalf("%q: body %s\nwant %s", c.accept, got, want)
		}
		// Revalidating with any encoding's tag: 304 naming this client's.
		for _, held := range []string{"", "gzip", "br"} {
			w := getDay(h, testDay, gen, map[string]string{"Accept-Encoding": c.accept, "If-None-Match": dayETag(gen, testDay, held)})
			if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("ETag") != dayETag(gen, testDay, c.enc) {
				t.Fatalf("%q holding %q: got %d %v", c.accept, held, w.Code, w.Header())
			}
		}
	}
	if db.reads.Load() != 1 || blobs.sets != 2 {
		t.Fatalf("database reads %d, Redis sets %d", db.reads.Load(), blobs.sets)
	}

	// A copy stored before D-168 has no br: a br client gets the gzip copy.
	key := "meshmap:obsday:" + gen + ":" + testDay
	delete(blobs.vals, key+":br")
	w := getDay(h, testDay, gen, map[string]string{"Accept-Encoding": "gzip, br"})
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" || w.Header().Get("ETag") != dayETag(gen, testDay, "gzip") {
		t.Fatalf("old copy: got %d %v", w.Code, w.Header())
	}
	if got, _ := io.ReadAll(decoded(t, w)); !bytes.Equal(got, want) {
		t.Fatalf("old copy: body %s", got)
	}
	// ... and a client taking only br gets it plain.
	w = getDay(h, testDay, gen, map[string]string{"Accept-Encoding": "br"})
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || w.Header().Get("ETag") != dayETag(gen, testDay, "") {
		t.Fatalf("old copy, br only: got %d %v", w.Code, w.Header())
	}
	if got, _ := io.ReadAll(decoded(t, w)); !bytes.Equal(got, want) || db.reads.Load() != 1 {
		t.Fatalf("old copy, br only: body %s, database reads %d", got, db.reads.Load())
	}
}

func TestDayNotFinalIsNotCached(t *testing.T) {
	cases := []struct {
		name    string
		db      *fakeRows
		date    string
		checked bool // DaySettled is consulted
	}{
		{"rows awaiting a new decoding, or writer behind", &fakeRows{settled: false}, testDay, true},
		{"import running", &fakeRows{settled: true, state: storage.HistoryState{Importing: true}}, testDay, false},
		{"import began while reading", &fakeRows{settled: true, during: &storage.HistoryState{Rev: 1, Importing: true}}, testDay, true},
		{"today", &fakeRows{settled: true}, testNow.Format(time.DateOnly), false},
		{"yesterday, not settled yet", &fakeRows{settled: true}, "2026-11-04", false},
	}
	for _, c := range cases {
		blobs := newBlobs()
		s, h := dayServer(t, c.db, blobs)
		if c.date == "2026-11-04" {
			s.Now = func() time.Time { return time.Date(2026, 11, 5, 0, 10, 0, 0, time.UTC) }
		}
		hdr := map[string]string{"Accept-Encoding": "gzip"}
		if !c.checked {
			// Not final by the clock or while importing: a held copy is not confirmed either.
			hdr["If-None-Match"] = dayETag(s.generation(c.db.state.Rev), c.date, "gzip")
		}
		w := getDay(h, c.date, s.generation(c.db.state.Rev), hdr)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("ETag") != "" {
			t.Errorf("%s: got %d %v", c.name, w.Code, w.Header())
		}
		if blobs.sets != 0 || (c.db.settledQs.Load() > 0) != c.checked {
			t.Errorf("%s: stored %d, settled checks %d", c.name, blobs.sets, c.db.settledQs.Load())
		}
		if c.checked && !c.db.settled {
			// Asked again a moment later: streamed without checking again.
			before := c.db.settledQs.Load()
			if w := getDay(h, c.date, s.generation(c.db.state.Rev), hdr); w.Code != 200 || c.db.settledQs.Load() != before {
				t.Errorf("%s again: %d, settled checks %d then %d", c.name, w.Code, before, c.db.settledQs.Load())
			}
		}
	}
}

// A day not final by the clock is streamed as read, in either encoding, with
// the body a build in memory would have held.
func TestDayNotFinalStreams(t *testing.T) {
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`, `{"i":2,"t":2}`, `{"i":3,"t":3}`}}
	s, h := dayServer(t, db, newBlobs())
	gen, today := s.generation(0), testNow.Format(time.DateOnly)
	b := s.Bounds()
	p, err := planDay(testNow.Truncate(24*time.Hour), b.Now, b.Cutoff)
	if err != nil || p.final {
		t.Fatalf("plan %+v %v", p, err)
	}
	head := ObservationsBody{Window: WindowEcho{Start: p.day.Start, End: p.day.End}, Since: p.rows.Start, Until: p.rows.End, Generation: gen}
	built, err := s.buildDay(context.Background(), db, p, head, storage.HistoryState{})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(built.gz))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := io.ReadAll(zr)
	for _, enc := range []string{"gzip", ""} {
		w := getDay(h, today, gen, map[string]string{"Accept-Encoding": enc})
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("ETag") != "" ||
			w.Header().Get("Content-Encoding") != enc || w.Header().Get("Content-Length") != "" {
			t.Fatalf("%q: got %d %v", enc, w.Code, w.Header())
		}
		got := w.Body.Bytes()
		if enc == "gzip" {
			zr, err := gzip.NewReader(w.Body)
			if err != nil {
				t.Fatal(err)
			}
			got, _ = io.ReadAll(zr)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%q: streamed %s\nbuilt %s", enc, got, want)
		}
	}
	if db.settledQs.Load() != 1 { // only the build above asked
		t.Fatalf("settled checks %d", db.settledQs.Load())
	}
}

// A crashed builder's lock lapses, but never while a live build still runs.
func TestDayLockOutlivesBuild(t *testing.T) {
	if lock, build := dayLockTTL, dayBuildLimit; lock < build {
		t.Fatalf("lock %s < build limit %s", lock, build)
	}
}

func TestDayWithoutRedis(t *testing.T) {
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`}}
	s, h := dayServer(t, db, nil)
	for range 2 {
		w := getDay(h, testDay, s.generation(0), map[string]string{"Accept-Encoding": "gzip"})
		if w.Code != 200 || w.Header().Get("Cache-Control") != immutableCC {
			t.Fatalf("got %d %v", w.Code, w.Header())
		}
	}
	if db.reads.Load() != 2 {
		t.Fatalf("database reads %d: without Redis each request builds", db.reads.Load())
	}
}

// Another replica holds the build lock: this one waits for its result, and
// builds its own only once the wait is over.
func TestDayWaitsForAnotherReplica(t *testing.T) {
	defer func(w, p time.Duration) { dayWait, dayPoll = w, p }(dayWait, dayPoll)
	dayWait, dayPoll = 2*time.Second, 10*time.Millisecond

	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`}}
	blobs := newBlobs()
	s, h := dayServer(t, db, blobs)
	gen := s.generation(0)
	key := "meshmap:obsday:" + gen + ":" + testDay
	blobs.locks[key+":lock"] = "other"
	var body bytes.Buffer
	zw := gzip.NewWriter(&body)
	_, _ = zw.Write([]byte(`{"window":{"start":"2026-11-03T00:00:00Z","end":"2026-11-04T00:00:00Z","rolling":false},"generation":"` + gen + `","rows":[{"i":9,"t":1}],"more":false}`))
	_ = zw.Close()
	go func() {
		time.Sleep(100 * time.Millisecond)
		_ = blobs.SetBlob(context.Background(), key, body.Bytes(), time.Hour)
	}()
	w := getDay(h, testDay, gen, nil)
	if _, rows := dayBody(t, w); w.Code != 200 || len(rows) != 1 || string(rows[0]) != `{"i":9,"t":1}` || db.reads.Load() != 0 {
		t.Fatalf("got %d, rows %s, database reads %d", w.Code, rows, db.reads.Load())
	}

	// A lock that is never released (a crashed replica): build after the wait.
	dayWait = 50 * time.Millisecond
	blobs.locks = map[string]string{}
	blobs.vals = map[string][]byte{}
	other := "2026-11-02"
	blobs.locks["meshmap:obsday:"+gen+":"+other+":lock"] = "crashed"
	w = getDay(h, other, gen, nil)
	if w.Code != 200 || db.reads.Load() != 1 || w.Header().Get("Cache-Control") != immutableCC {
		t.Fatalf("got %d, database reads %d", w.Code, db.reads.Load())
	}
	// A lock freed without a result (its build was not final): take it at once.
	dayWait = time.Minute
	third := "2026-11-01"
	lock := "meshmap:obsday:" + gen + ":" + third + ":lock"
	blobs.locks[lock] = "other"
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = blobs.Unlock(context.Background(), lock, "other")
	}()
	start := time.Now()
	if w = getDay(h, third, gen, nil); w.Code != 200 || db.reads.Load() != 2 || time.Since(start) > 5*time.Second {
		t.Fatalf("got %d, database reads %d after %s", w.Code, db.reads.Load(), time.Since(start))
	}
	if _, held := blobs.locks[lock]; held {
		t.Fatal("lock not released after the build")
	}
}

// Concurrent requests in one process share one build.
func TestDaySingleBuildPerProcess(t *testing.T) {
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`}, gate: make(chan struct{})}
	s, h := dayServer(t, db, nil)
	gen := s.generation(0)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if w := getDay(h, testDay, gen, nil); w.Code != 200 {
				t.Errorf("got %d", w.Code)
			}
		})
	}
	time.Sleep(200 * time.Millisecond) // all eight are waiting on the one build
	close(db.gate)
	wg.Wait()
	if n := db.reads.Load(); n != 1 {
		t.Fatalf("database reads %d", n)
	}
}

func TestDayHeavyPath(t *testing.T) {
	for p, want := range map[string]bool{"/api/v1/observations": true, "/api/v1/observations/day/2026-11-03": true, "/api/v1/trends": false} {
		if heavy(p) != want {
			t.Errorf("heavy(%q) != %v", p, want)
		}
	}
}

// A day too large to build is streamed, and later requests stream it at
// once instead of building (and discarding) it again.
func TestDayTooLargeStreamsWithoutRebuilding(t *testing.T) {
	defer func(m int) { dayMaxBytes = m }(dayMaxBytes)
	dayMaxBytes = 16
	db := &fakeRows{settled: true, rows: []string{`{"i":1,"t":1}`, `{"i":2,"t":2}`}}
	blobs := newBlobs()
	s, h := dayServer(t, db, blobs)
	gen := s.generation(0)
	for i := range 3 {
		w := getDay(h, testDay, gen, map[string]string{"Accept-Encoding": "gzip"})
		if _, rows := dayBody(t, w); w.Code != 200 || len(rows) != 2 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("request %d: got %d, rows %s, %v", i, w.Code, rows, w.Header())
		}
	}
	// One build that gave up, then a stream per request: 1 + 3 reads, one settled query.
	if r, q := db.reads.Load(), db.settledQs.Load(); r != 4 || q != 1 {
		t.Fatalf("database reads %d, settled queries %d", r, q)
	}
	// Another replica sharing the Redis learns it from there and builds nothing.
	db2 := &fakeRows{settled: true, rows: db.rows}
	_, h2 := dayServer(t, db2, blobs)
	if w := getDay(h2, testDay, gen, nil); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("other replica: got %d, %v", w.Code, w.Header())
	}
	if r, q := db2.reads.Load(), db2.settledQs.Load(); r != 1 || q != 0 {
		t.Fatalf("other replica: database reads %d, settled queries %d; want only the stream", r, q)
	}
}
