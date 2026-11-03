package weather

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is MET Norway's OPeNDAP root, holding the MET Nordic
// analysis archive (metpparchive) and MEPS runs (meps25epsarchive).
const DefaultBaseURL = "https://thredds.met.no/thredds/dodsC"

// Attribution is what MET Norway's licence (CC BY 4.0) asks for.
const Attribution = "Weather: MET Nordic analysis and MEPS from MET Norway (CC BY 4.0)"

// Hour is the weather in one cell for one hour; nil where MET Norway has no value.
type Hour struct {
	T           time.Time `json:"t" doc:"Valid time (UTC, on the hour)"`
	TempC       *float64  `json:"temp_c,omitempty" doc:"Air temperature 2 m above ground, °C"`
	PrecipMM    *float64  `json:"precip_mm,omitempty" doc:"Precipitation in the hour before t, mm"`
	HumidityPct *float64  `json:"humidity_pct,omitempty" doc:"Relative humidity 2 m above ground, %"`
	CloudPct    *float64  `json:"cloud_pct,omitempty" doc:"Cloud cover, %"`
	WindMS      *float64  `json:"wind_ms,omitempty" doc:"Wind speed 10 m above ground, m/s"`
	GustMS      *float64  `json:"gust_ms,omitempty" doc:"Strongest gust 10 m above ground, m/s, from the first hours of a MEPS forecast run (the analysis has none)"`
}

const (
	freshFor   = 3 * time.Hour    // fresh hours may still be re-analysed, or not be published yet
	freshTTL   = 20 * time.Minute // how long a fresh hour is reused
	missingTTL = 10 * time.Minute // a fresh hour not yet published
	gustsFor   = 12 * time.Hour   // MEPS runs reach the archive hours late: an hour without a gust is asked again until then
	goneTTL    = 6 * time.Hour    // an old hour missing from the archive
	maxEntries = 200_000          // cached hours, about 20 MB
	maxQueue   = 20_000           // hours waiting to be fetched
	// The archive answers 429 to more than about one request at a time, so
	// one worker fetches every hour in turn, at most every Interval.
	defaultInterval = 250 * time.Millisecond
	defaultBackoff  = 30 * time.Second
)

// Client fetches hours in the background and serves them from memory.
// Create it with New and start its worker with Run.
type Client struct {
	HTTP      *http.Client
	BaseURL   string
	UserAgent string
	Now       func() time.Time
	Interval  time.Duration // between upstream requests
	Store     *Store        // where fetched hours are kept; nil: memory only
	Log       *slog.Logger

	mu     sync.Mutex
	cache  map[key]entry
	order  []key // insertion order, for eviction
	queue  []key
	queued map[key]bool
	wake   chan struct{}
}

type key struct {
	c Cell
	h int64 // Unix hour
}

func (k key) t() time.Time { return time.Unix(k.h*3600, 0).UTC() }

type entry struct {
	h       Hour
	missing bool
	expires time.Time // zero: never
}

// expiry is when an hour fetched at `fetched` should be asked for again:
// never once it had settled, sooner while it was fresh, not yet published or
// still waiting for its MEPS run.
func expiry(h Hour, fetched time.Time, missing bool) time.Time {
	age := fetched.Sub(h.T)
	switch {
	case missing && age < freshFor:
		return fetched.Add(missingTTL)
	case missing:
		return fetched.Add(goneTTL)
	case age < freshFor:
		return fetched.Add(freshTTL)
	case h.GustMS == nil && age < gustsFor:
		return fetched.Add(missingTTL)
	}
	return time.Time{}
}

func (e entry) valid(now time.Time) bool { return e.expires.IsZero() || now.Before(e.expires) }

func New(baseURL, userAgent string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{HTTP: &http.Client{Timeout: 15 * time.Second}, BaseURL: strings.TrimRight(baseURL, "/"), UserAgent: userAgent,
		Interval: defaultInterval, cache: map[key]entry{}, queued: map[key]bool{}, wake: make(chan struct{}, 1)}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

// Series returns the known hours in [start, end) for a cell, oldest first,
// leaving out hours the analysis lacks. Hours neither in memory nor in the
// store are queued for the worker, newest first, and reported as
// incomplete: asking again later fills them in.
func (c *Client) Series(ctx context.Context, cell Cell, start, end time.Time) (hours []Hour, incomplete bool) {
	first := start.UTC().Truncate(time.Hour)
	if first.Before(start) {
		first = first.Add(time.Hour)
	}
	now := c.now()
	// Hours not yet over have no analysis.
	var ks []key
	for t := first; t.Before(end) && !t.After(now); t = t.Add(time.Hour) {
		ks = append(ks, key{cell, t.Unix() / 3600})
	}
	if len(ks) == 0 {
		return nil, false
	}
	if c.Store != nil && c.uncached(ks, now) {
		rows, err := c.Store.load(ctx, cell, ks[0].t(), ks[len(ks)-1].t().Add(time.Hour))
		if err != nil {
			c.warn("weather store read failed", err)
		}
		c.mu.Lock()
		for _, r := range rows {
			c.put(key{cell, r.h.T.Unix() / 3600}, entry{r.h, r.missing, expiry(r.h, r.fetched, r.missing)})
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var want []key
	for _, k := range ks {
		e, ok := c.cache[k]
		if !ok || !e.valid(now) {
			want = append(want, k)
			incomplete = true
			if !ok {
				continue
			}
		}
		if !e.missing {
			hours = append(hours, e.h)
		}
	}
	for i := len(want) - 1; i >= 0; i-- {
		if k := want[i]; !c.queued[k] && len(c.queue) < maxQueue {
			c.queued[k] = true
			c.queue = append(c.queue, k)
		}
	}
	if len(want) > 0 {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	return hours, incomplete
}

// uncached reports whether any hour is missing from memory or outdated there.
func (c *Client) uncached(ks []key, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range ks {
		if e, ok := c.cache[k]; !ok || !e.valid(now) {
			return true
		}
	}
	return false
}

func (c *Client) warn(msg string, err error) {
	if c.Log != nil {
		c.Log.Warn(msg, "err", err)
	}
}

// Run fetches queued hours one at a time until ctx ends. A failed hour is
// dropped from the queue; the next request for it queues it again.
func (c *Client) Run(ctx context.Context) {
	for {
		c.mu.Lock()
		var k key
		ok := len(c.queue) > 0
		if ok {
			k = c.queue[0]
			c.queue = c.queue[1:]
		}
		c.mu.Unlock()
		if !ok {
			select {
			case <-c.wake:
				continue
			case <-ctx.Done():
				return
			}
		}
		h, missing, wait, err := c.fetch(ctx, k.c, k.t())
		now := c.now()
		c.mu.Lock()
		delete(c.queued, k)
		if err == nil {
			c.put(k, entry{h, missing, expiry(h, now, missing)})
		}
		c.mu.Unlock()
		if err == nil && c.Store != nil {
			if err := c.Store.save(ctx, k.c, stored{h, missing, now}); err != nil {
				c.warn("weather store write failed", err)
			}
		}
		select {
		case <-time.After(max(wait, c.Interval)):
		case <-ctx.Done():
			return
		}
	}
}

// put stores an entry, dropping the oldest tenth when full. Callers hold mu.
func (c *Client) put(k key, e entry) {
	if _, ok := c.cache[k]; !ok {
		if len(c.order) >= maxEntries {
			drop := maxEntries / 10
			for _, old := range c.order[:drop] {
				delete(c.cache, old)
			}
			c.order = append(c.order[:0], c.order[drop:]...)
		}
		c.order = append(c.order, k)
	}
	c.cache[k] = e
}

// get reads single values from an OPeNDAP ASCII URL; missing is true when
// the file does not exist (not yet, or never, published), and wait is how
// long to hold off when the server asks us to.
func (c *Client) get(ctx context.Context, url string) (vals map[string]float64, missing bool, wait time.Duration, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, 0, err
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, false, 0, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, true, 0, nil
	case http.StatusTooManyRequests, http.StatusServiceUnavailable:
		wait = defaultBackoff
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 {
			wait = time.Duration(s) * time.Second
		}
		return nil, false, wait, fmt.Errorf("weather: upstream status %d", resp.StatusCode)
	default:
		return nil, false, 0, fmt.Errorf("weather: upstream status %d", resp.StatusCode)
	}
	vals, err = parseASCII(io.LimitReader(resp.Body, 64<<10))
	return vals, false, 0, err
}

// index is an OPeNDAP hyperslab of single indices, URL-escaped: [a][b]...
func index(is ...int) string {
	var b strings.Builder
	for _, i := range is {
		fmt.Fprintf(&b, "%%5B%d%%5D", i)
	}
	return b.String()
}

func round2(v float64) *float64 {
	v = math.Round(v*100) / 100
	return &v
}

// fetch reads one hour at one analysis cell, and its gust from MEPS; missing
// is true when the analysis has no file for that hour.
func (c *Client) fetch(ctx context.Context, cell Cell, t time.Time) (h Hour, missing bool, wait time.Duration, err error) {
	at := index(0, cell.Y, cell.X)
	vars := []string{"air_temperature_2m", "precipitation_amount", "relative_humidity_2m", "cloud_area_fraction", "wind_speed_10m"}
	q := make([]string, len(vars))
	for i, v := range vars {
		q[i] = v + at
	}
	vals, missing, wait, err := c.get(ctx, fmt.Sprintf("%s/metpparchive/%s/met_analysis_1_0km_nordic_%s.nc.ascii?%s",
		c.BaseURL, t.Format("2006/01/02"), t.Format("20060102T15Z"), strings.Join(q, ",")))
	if err != nil || missing {
		return Hour{T: t}, missing, wait, err
	}
	h = Hour{T: t}
	if v, ok := vals["air_temperature_2m"]; ok {
		h.TempC = round2(v - 273.15)
	}
	if v, ok := vals["precipitation_amount"]; ok {
		h.PrecipMM = round2(math.Max(v, 0))
	}
	if v, ok := vals["relative_humidity_2m"]; ok {
		h.HumidityPct = round2(math.Min(math.Max(v, 0), 1) * 100)
	}
	if v, ok := vals["cloud_area_fraction"]; ok {
		h.CloudPct = round2(math.Min(math.Max(v, 0), 1) * 100)
	}
	if v, ok := vals["wind_speed_10m"]; ok {
		h.WindMS = round2(math.Max(v, 0))
	}
	h.GustMS, wait, err = c.gust(ctx, cell, t)
	return h, false, wait, err
}

// gust is the strongest gust in the hour before t at a cell, from the latest
// MEPS run in the archive that covers it with one of its first hours: runs
// start every 3 h and reach the archive hours late. Nil when none has it yet.
func (c *Client) gust(ctx context.Context, cell Cell, t time.Time) (*float64, time.Duration, error) {
	mc, ok := meps.cell(analysis.centre(cell))
	if !ok {
		return nil, 0, nil
	}
	run := t.Truncate(3 * time.Hour)
	for range 3 {
		select {
		case <-time.After(c.Interval):
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		}
		at := index(int(t.Sub(run)/time.Hour), 0, mc.Y, mc.X)
		vals, missing, wait, err := c.get(ctx, fmt.Sprintf("%s/meps25epsarchive/%s/meps_det_2_5km_%s.nc.ascii?x_wind_gust_10m%s,y_wind_gust_10m%s",
			c.BaseURL, run.Format("2006/01/02"), run.Format("20060102T15Z"), at, at))
		if err != nil {
			return nil, wait, err
		}
		if !missing {
			// A vector in the grid's axes: its length is the gust speed.
			x, okx := vals["x_wind_gust_10m"]
			y, oky := vals["y_wind_gust_10m"]
			if !okx || !oky {
				return nil, 0, nil
			}
			return round2(math.Hypot(x, y)), 0, nil
		}
		run = run.Add(-3 * time.Hour)
	}
	return nil, 0, nil
}

// parseASCII reads an OPeNDAP ASCII response of single-value grids: a line
// "name.name[1]...[1]" followed by "[0]...[0], value". NaN values are left out.
func parseASCII(r io.Reader) (map[string]float64, error) {
	out := map[string]float64{}
	sc := bufio.NewScanner(r)
	var grid string
	seen := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if name, _, ok := strings.Cut(line, "."); ok && strings.HasPrefix(line[len(name)+1:], name+"[") {
			grid = name
			continue
		}
		if i := strings.LastIndex(line, "], "); grid != "" && strings.HasPrefix(line, "[") && i > 0 {
			seen = true
			if v, err := strconv.ParseFloat(line[i+3:], 64); err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) {
				out[grid] = v
			}
			grid = ""
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !seen {
		return nil, errors.New("weather: no values in upstream response")
	}
	return out, nil
}
