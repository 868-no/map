package places

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotLoaded: no place names have been imported yet.
var ErrNotLoaded = errors.New("places: the place-name register is not loaded yet")

// ErrBusy: another process is importing place names.
var ErrBusy = errors.New("places: an import is already running elsewhere")

// Store searches the place names loaded into the database (place_name and
// place_key, storage/schema.sql).
type Store struct {
	Pool *pgxpool.Pool
}

// candidates is how many matches are ranked before one per name and
// municipality is kept.
const candidates = 200

// Search finds places with a word starting with q (the whole search, both
// folded by Fold, so "st olav" finds St. Olavs gate and "nord fron"
// Nord-Fron), best first: names equal to q, then by kind (rank: towns,
// districts and villages before other features, farms, roads and buildings
// last), then Kartverket's importance, a place's main name before its
// others, shorter names first. A place is listed once, by its best-matching
// name (Oslo, not also Oslo suohkan), and a name once per municipality, as
// its best-ranked place.
func (s *Store) Search(ctx context.Context, q string) ([]Place, error) {
	q, err := Normalize(q)
	if err != nil {
		return nil, err
	}
	like := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	rows, err := s.Pool.Query(ctx, `SELECT n.place_id, n.name, n.kind, n.municipality, n.county, n.lat, n.lon
		FROM place_name n
		WHERE n.id IN (SELECT name_id FROM place_key WHERE key LIKE $1)
		ORDER BY n.name_lc = $2 DESC, n.rank, n.importance DESC, n.alt, length(n.name_lc), n.name_lc
		LIMIT $3`, like, q, candidates)
	if err != nil {
		return nil, err
	}
	type hit struct {
		Place
		id int
	}
	ps, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (hit, error) {
		var h hit
		err := r.Scan(&h.id, &h.Name, &h.Kind, &h.Municipality, &h.County, &h.Lat, &h.Lon)
		return h, err
	})
	if err != nil {
		return nil, err
	}
	if len(ps) == 0 {
		var any bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM place_name)`).Scan(&any); err != nil {
			return nil, err
		}
		if !any {
			return nil, ErrNotLoaded
		}
	}
	out := []Place{}
	once := map[string]bool{}
	places := map[int]bool{}
	for _, p := range ps {
		key := strings.ToLower(p.Name) + "|" + p.Municipality
		if p.Municipality == "" { // out at sea: one per name and kind
			key += "|" + p.Kind
		}
		if once[key] || places[p.id] {
			continue
		}
		once[key], places[p.id] = true, true
		out = append(out, p.Place)
		if len(out) == perSearch {
			break
		}
	}
	return out, nil
}

// LoadedAt is when the loaded place names were imported, zero if never.
func LoadedAt(ctx context.Context, pool *pgxpool.Pool) (time.Time, error) {
	at, _, err := loaded(ctx, pool)
	return at, err
}

// loaded reads the table comment Load writes: when the names were loaded
// and under which FoldVersion ("<RFC 3339> fold=<n> ..."; 1 when it names
// none, as before versions were recorded). Zero time if never loaded.
func loaded(ctx context.Context, pool *pgxpool.Pool) (time.Time, int, error) {
	var c *string
	if err := pool.QueryRow(ctx, `SELECT obj_description(to_regclass('public.place_name'), 'pg_class')`).Scan(&c); err != nil || c == nil {
		return time.Time{}, 0, err
	}
	f := strings.Fields(*c)
	if len(f) == 0 {
		return time.Time{}, 0, nil
	}
	t, err := time.Parse(time.RFC3339, f[0])
	if err != nil {
		return time.Time{}, 0, nil //nolint:nilerr // another comment: as if never loaded
	}
	version := 1
	if len(f) > 1 {
		if v, ok := strings.CutPrefix(f[1], "fold="); ok {
			if n, err := strconv.Atoi(v); err == nil {
				version = n
			}
		}
	}
	return t, version, nil
}

// LoadStats summarises an import.
type LoadStats struct {
	ParseStats
	Keys     int64
	Duration time.Duration
}

// Load replaces the place names with those parse yields. It loads into
// tables of their own schema (places_load) and swaps them in at the end, so
// searches meanwhile use the old names; one import runs at a time.
func Load(ctx context.Context, pool *pgxpool.Pool, source string, parse func(func(Record) error) (ParseStats, error)) (LoadStats, error) {
	start := time.Now()
	var st LoadStats
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return st, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext('meshmap:places'))`).Scan(&got); err != nil {
		return st, err
	}
	if !got {
		return st, ErrBusy
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext('meshmap:places'))`) //nolint:errcheck
	for _, q := range []string{
		`CREATE SCHEMA IF NOT EXISTS places_load`,
		`DROP TABLE IF EXISTS places_load.place_name, places_load.place_key`,
		`CREATE TABLE places_load.place_name (LIKE public.place_name)`,
		`CREATE TABLE places_load.place_key (LIKE public.place_key)`,
	} {
		if _, err := conn.Exec(ctx, q); err != nil {
			return st, fmt.Errorf("places: %w", err)
		}
	}
	// Parse while copying: rows flow through a channel into COPY.
	recs := make(chan []any, 1024)
	perr := make(chan error, 1)
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		id := 0
		ps, err := parse(func(r Record) error {
			id++
			select {
			case recs <- []any{id, r.ID, r.Alt, r.Name, Fold(r.Name), r.Kind, int16(rank(r.Code)), int16(r.Importance), r.Municipality, r.County, r.Lat, r.Lon}:
				return nil
			case <-pctx.Done():
				return pctx.Err()
			}
		})
		st.ParseStats = ps
		close(recs)
		perr <- err
	}()
	cols := []string{"id", "place_id", "alt", "name", "name_lc", "kind", "rank", "importance", "municipality", "county", "lat", "lon"}
	_, cerr := conn.CopyFrom(ctx, pgx.Identifier{"places_load", "place_name"}, cols, &chanSource{ch: recs})
	if cerr != nil {
		cancel()
		for range recs { // let the parser finish
		}
	}
	if err := errors.Join(<-perr, cerr); err != nil {
		return st, fmt.Errorf("places: %w", err)
	}
	if st.Names == 0 {
		return st, errors.New("places: the file held no place names")
	}
	// Every word start of a folded name (Fold: words are separated by single
	// spaces) is a key, so a search matches any word: "galdh" finds Vesle
	// Galdhøpiggen, "fron" and "nord fron" Nord-Fron.
	tag, err := conn.Exec(ctx, `INSERT INTO places_load.place_key (key, name_id)
		SELECT DISTINCT substr(n.name_lc, g.p), n.id FROM places_load.place_name n, generate_series(1, length(n.name_lc)) g(p)
		WHERE g.p = 1 OR substr(n.name_lc, g.p - 1, 1) = ' '`)
	if err != nil {
		return st, fmt.Errorf("places: keys: %w", err)
	}
	st.Keys = tag.RowsAffected()
	for _, q := range []string{
		`ALTER TABLE places_load.place_name ADD CONSTRAINT place_name_pkey PRIMARY KEY (id)`,
		`CREATE INDEX place_key_key_idx ON places_load.place_key (key)`,
		`ANALYZE places_load.place_name`,
		`ANALYZE places_load.place_key`,
	} {
		if _, err := conn.Exec(ctx, q); err != nil {
			return st, fmt.Errorf("places: %w", err)
		}
	}
	comment := fmt.Sprintf("%s fold=%d %d names from %s", time.Now().UTC().Format(time.RFC3339), FoldVersion, st.Names, source)
	err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		for _, q := range []string{
			`DROP TABLE public.place_key, public.place_name`,
			`ALTER TABLE places_load.place_name SET SCHEMA public`,
			`ALTER TABLE places_load.place_key SET SCHEMA public`,
			`COMMENT ON TABLE public.place_name IS ` + quote(comment),
		} {
			if _, err := tx.Exec(ctx, q); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return st, fmt.Errorf("places: swap: %w", err)
	}
	st.Duration = time.Since(start)
	return st, nil
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// chanSource feeds COPY from a channel of rows.
type chanSource struct {
	ch  chan []any
	row []any
}

func (c *chanSource) Next() bool {
	r, ok := <-c.ch
	c.row = r
	return ok
}
func (c *chanSource) Values() ([]any, error) { return c.row, nil }
func (c *chanSource) Err() error             { return nil }

// Import loads the register from src: a URL of Geonorge's GML download (a
// zip), or a local .zip or .gml file.
func Import(ctx context.Context, pool *pgxpool.Pool, src, userAgent string, log *slog.Logger) (LoadStats, error) {
	path := src
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		f, err := download(ctx, src, userAgent)
		if err != nil {
			return LoadStats{}, err
		}
		defer os.Remove(f) //nolint:errcheck // a temporary file
		path = f
	}
	open := func() (io.ReadCloser, error) { return os.Open(path) }
	if strings.EqualFold(filepath.Ext(path), ".zip") || strings.HasPrefix(src, "http") {
		open = func() (io.ReadCloser, error) { return openGML(path) }
	}
	r, err := open()
	if err != nil {
		return LoadStats{}, err
	}
	defer r.Close()
	if log != nil {
		log.Info("importing place names", "source", src)
	}
	return Load(ctx, pool, src, func(fn func(Record) error) (ParseStats, error) { return Parse(r, fn) })
}

// openGML opens the first .gml file in a zip.
func openGML(path string) (io.ReadCloser, error) {
	z, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("places: %w", err)
	}
	for _, f := range z.File {
		if strings.EqualFold(filepath.Ext(f.Name), ".gml") {
			r, err := f.Open()
			if err != nil {
				return nil, errors.Join(err, z.Close())
			}
			return struct {
				io.Reader
				io.Closer
			}{r, closers{r, z}}, nil
		}
	}
	return nil, errors.Join(errors.New("places: no .gml file in the zip"), z.Close())
}

type closers []io.Closer

func (c closers) Close() error {
	var err error
	for _, x := range c {
		err = errors.Join(err, x.Close())
	}
	return err
}

// download saves url to a temporary file and returns its path.
func download(ctx context.Context, url, userAgent string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return "", fmt.Errorf("places: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("places: %s answered %s", url, res.Status)
	}
	f, err := os.CreateTemp("", "stedsnavn-*.zip")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, res.Body); err != nil {
		return "", errors.Join(fmt.Errorf("places: download: %w", err), f.Close(), os.Remove(f.Name()))
	}
	return f.Name(), f.Close()
}

// Refresh imports the register when none is loaded, the loaded one is older
// than maxAge, or it was loaded under another FoldVersion (its names and
// keys are folded differently from what searches now are). Another process
// importing is not an error.
func Refresh(ctx context.Context, pool *pgxpool.Pool, src, userAgent string, maxAge time.Duration, log *slog.Logger) error {
	at, version, err := loaded(ctx, pool)
	if err != nil {
		return err
	}
	if !at.IsZero() && time.Since(at) < maxAge {
		if version == FoldVersion {
			return nil
		}
		log.Info("place names were loaded under another key format; loading them again", "loaded", version, "current", FoldVersion)
	}
	st, err := Import(ctx, pool, src, userAgent, log)
	if errors.Is(err, ErrBusy) {
		log.Info("place names: another process is importing them")
		return nil
	}
	if err != nil {
		return err
	}
	log.Info("place names imported", "places", st.Places, "names", st.Names, "keys", st.Keys, "without_point", st.NoPoint, "duration", st.Duration.Round(time.Second).String())
	return nil
}
