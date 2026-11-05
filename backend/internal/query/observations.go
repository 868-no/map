package query

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
)

// MaxObservationPage bounds one page of raw observations.
const MaxObservationPage = 20000

// ObsRow is obsrow.ObsRow: the same compact row is streamed live.
type ObsRow = obsrow.ObsRow

// Cursor is a position in (observed_at, id) order: the last row returned.
type Cursor struct {
	At time.Time
	ID int64
}

// String encodes the cursor for clients: Unix microseconds and row id.
func (c Cursor) String() string { return fmt.Sprintf("%d.%d", c.At.UnixMicro(), c.ID) }

// ParseCursor decodes Cursor.String; ok is false for anything else.
func ParseCursor(s string) (Cursor, bool) {
	us, id, found := strings.Cut(s, ".")
	if !found {
		return Cursor{}, false
	}
	u, err1 := strconv.ParseInt(us, 10, 64)
	i, err2 := strconv.ParseInt(id, 10, 64)
	if err1 != nil || err2 != nil || i < 0 {
		return Cursor{}, false
	}
	return Cursor{At: time.UnixMicro(u).UTC(), ID: i}, true
}

// Page is one page of a window's rows, read from the database as they are
// written out: rows of w after the cursor (all of them when nil), in
// (observed_at, id) order, at most limit of them. Time order lets the
// observed_at index serve every page; id order made PostgreSQL walk the
// primary key through all older rows (D-038). Callers narrow w (never widen
// it) to fetch only what they do not hold. Rows come encoded, mostly
// straight from obs_row (D-046), and are never collected in memory (D-057).
type Page struct {
	rows  pgx.Rows
	limit int
	after *Cursor
	last  Cursor
	n     int
	more  bool
}

// OpenPage starts the query, so errors up to the first row are reported
// before anything is written. Close it when done.
func OpenPage(ctx context.Context, pool *pgxpool.Pool, w window.Window, after *Cursor, limit int) (*Page, error) {
	if limit <= 0 || limit > MaxObservationPage {
		limit = MaxObservationPage
	}
	return openPage(ctx, pool, w, after, limit)
}

// OpenAll is OpenPage without a page size: every row of w, for the day
// cache, which serves a whole UTC day as one body (D-158).
func OpenAll(ctx context.Context, pool *pgxpool.Pool, w window.Window) (*Page, error) {
	return openPage(ctx, pool, w, nil, 0)
}

// openPage reads at most limit rows after the cursor; limit 0 reads all.
func openPage(ctx context.Context, pool *pgxpool.Pool, w window.Window, after *Cursor, limit int) (*Page, error) {
	b := where(w)
	if after != nil {
		// A cursor inside the window, never a bound on it.
		b.and("(observed_at, id) > (?, ?)", after.At, after.ID)
	}
	ver := b.arg(int16(obsrow.Version))
	tail := ""
	if limit > 0 {
		tail = ` LIMIT ` + b.arg(limit+1)
	} else {
		limit = math.MaxInt
	}
	rows, err := pool.Query(ctx, `SELECT `+storage.ObsColumns(ver)+`
		FROM packet_log WHERE `+b.String()+` ORDER BY observed_at, id`+tail, b.args...)
	if err != nil {
		return nil, err
	}
	return &Page{rows: rows, limit: limit, after: after}, nil
}

// Each calls emit with each row's JSON in order; the slice is only valid
// during the call. It stops after limit rows, noting whether more remain.
func (p *Page) Each(emit func(row []byte) error) error {
	buf := make([]byte, 0, 1024)
	for p.rows.Next() {
		f, tail, meta, err := storage.ScanObs(p.rows)
		if err != nil {
			return err
		}
		if p.n == p.limit {
			p.more = true
			break
		}
		if tail != nil {
			buf = obsrow.AppendWithID(buf[:0], f.ID, tail)
		} else if buf, err = json.Marshal(obsrow.New(f, meta)); err != nil {
			// Not yet re-encoded for this version (BackfillObsRows).
			return err
		}
		if err := emit(buf); err != nil {
			return err
		}
		p.n++
		p.last = Cursor{At: f.At, ID: f.ID}
	}
	p.rows.Close()
	return p.rows.Err()
}

// More reports whether rows remain after this page (valid after Each).
func (p *Page) More() bool { return p.more }

// Next is the cursor after the last row written: the request's own cursor
// when the page was empty (valid after Each).
func (p *Page) Next() *Cursor {
	if p.n == 0 {
		return p.after
	}
	c := p.last
	return &c
}

// Close releases the connection; safe to call more than once.
func (p *Page) Close() { p.rows.Close() }
