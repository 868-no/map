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
	SunWM2      *float64  `json:"sun_wm2,omitempty" doc:"Sunlight reaching the ground (downwelling shortwave radiation), mean over the hour before t, W/m²"`
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
	maxQueue   = 20_000           // hours waiting to be fetched, in each of the two queues
	// Hours one visitor may have waiting. Visitors are served in turn, an
	// hour each, so one asking for much delays others by little (D-141).
	maxPerClient = 5_000
	// The archive answers 429 to more than one request at a time, so one
	// worker fetches every hour in turn, pausing Interval between requests.
	defaultInterval = 100 * time.Millisecond
	maxRuns         = 50_000 // cached MEPS runs (gusts per cell)
	defaultBackoff  = 30 * time.Second
)

// SettledAfter is how long after an hour the hour may still change: past
// it, an hour is never asked for again.
const SettledAfter = gustsFor

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

	mu    sync.Mutex
	cache map[key]entry
	order []key // insertion order, for eviction
	// Hours to fetch: what visitors asked for first, each visitor's in turn,
	// then what Keep queued.
	urgent     map[string][]key // per visitor (Protect's client key), in asking order
	turns      []string         // visitors with hours waiting, next first
	nUrgent    int              // hours in urgent
	background []key
	queued     map[key]uint8 // the furthest-forward queue holding the hour
	runs       map[runKey]runEntry
	wake       chan struct{}
}

// runKey is one MEPS run at one MEPS cell.
type runKey struct {
	c   Cell
	run int64 // Unix hour of the run
}

// runEntry holds a run's gusts by lead hour (NaN: none), or that the
// archive lacked it until expires.
type runEntry struct {
	gusts   []float64
	expires time.Time // zero: never
}

// Which queue holds an hour (queued); absent: neither.
const (
	inBackground uint8 = iota + 1
	inUrgent
)

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
		Interval: defaultInterval, cache: map[key]entry{}, urgent: map[string][]key{}, queued: map[key]uint8{}, runs: map[runKey]runEntry{}, wake: make(chan struct{}, 1)}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

// Series returns the known hours in [start, end) for a cell, oldest first,
// leaving out hours the analysis lacks. Hours neither in memory nor in the
// store are queued for the worker ahead of background work, newest first,
// and reported as incomplete: asking again later fills them in.
func (c *Client) Series(ctx context.Context, cell Cell, start, end time.Time) (hours []Hour, incomplete bool) {
	return c.SeriesFor(ctx, "", cell, start, end)
}

// SeriesFor is Series for one visitor: its missing hours wait in its own
// queue, served in turn with other visitors' (D-141).
func (c *Client) SeriesFor(ctx context.Context, client string, cell Cell, start, end time.Time) (hours []Hour, incomplete bool) {
	return c.series(ctx, client, cell, start, end, true)
}

// Keep fills the weather of the cells sites returns, over the span before
// now, whenever every elapses, so visitors find it ready (D-133). It runs
// until ctx ends; visitors' requests go first.
func (c *Client) Keep(ctx context.Context, every, span time.Duration, sites func(context.Context) ([]Cell, error)) {
	for {
		cells, err := sites(ctx)
		if err != nil {
			c.warn("weather sites failed", err)
		}
		// A day at a time across all cells, newest first: every site gets its
		// latest days before any gets its oldest.
		now := c.now()
		for d := time.Duration(0); d < span; d += 24 * time.Hour {
			for _, cell := range cells {
				c.series(ctx, "", cell, now.Add(-min(d+24*time.Hour, span)), now.Add(-d), false)
			}
		}
		select {
		case <-time.After(every):
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) series(ctx context.Context, client string, cell Cell, start, end time.Time, urgent bool) (hours []Hour, incomplete bool) {
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
			exp := expiry(r.h, r.fetched, r.missing)
			if r.old {
				exp = r.fetched // already due: lacks what this version fetches
			}
			c.put(key{cell, r.h.T.Unix() / 3600}, entry{r.h, r.missing, exp})
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
		// A visitor's hour already waiting in the background queue is queued
		// again in front; the worker skips whichever copy comes second. An
		// hour already waiting (for anyone) is not added again: browsers
		// re-poll every few seconds while incomplete.
		k := want[i]
		switch {
		case urgent && c.queued[k] < inUrgent && c.room(client):
			if len(c.urgent[client]) == 0 {
				c.turns = append(c.turns, client)
			}
			c.urgent[client] = append(c.urgent[client], k)
			c.nUrgent++
			c.queued[k] = inUrgent
		case !urgent && c.queued[k] == 0 && len(c.background) < maxQueue:
			c.background = append(c.background, k)
			c.queued[k] = inBackground
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

// room reports whether a visitor may queue another hour: it holds fewer
// than maxPerClient, and the urgent queue has room, or makes room by taking
// the last hour of the visitor holding the most, when that one holds at
// least two more. c.mu is held.
func (c *Client) room(client string) bool {
	mine := len(c.urgent[client])
	if mine >= maxPerClient {
		return false
	}
	if c.nUrgent < maxQueue {
		return true
	}
	big, n := "", 0
	for id, q := range c.urgent {
		if len(q) > n {
			big, n = id, len(q)
		}
	}
	if n < mine+2 {
		return false
	}
	k := c.urgent[big][n-1]
	c.urgent[big] = c.urgent[big][:n-1] // n ≥ 2: never emptied, so still in turns
	c.nUrgent--
	if c.queued[k] == inUrgent {
		delete(c.queued, k) // a copy in the background queue goes too; Keep queues it again
	}
	return true
}

// pending is how many hours wait in the queues.
func (c *Client) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nUrgent + len(c.background)
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
		ok := false
		for !ok && (c.nUrgent > 0 || len(c.background) > 0) {
			if c.nUrgent > 0 {
				// The next visitor's oldest request; it goes to the back of the line.
				id := c.turns[0]
				q := c.urgent[id]
				k, q = q[0], q[1:]
				c.nUrgent--
				c.turns = c.turns[1:]
				if len(q) == 0 {
					delete(c.urgent, id)
				} else {
					c.urgent[id] = q
					c.turns = append(c.turns, id)
				}
			} else {
				k, c.background = c.background[0], c.background[1:]
			}
			// Skip a copy whose hour was fetched (through its other copy) or
			// loaded from the store since it was queued.
			if e, cached := c.cache[k]; cached && e.valid(c.now()) {
				delete(c.queued, k)
				continue
			}
			ok = c.queued[k] != 0
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
			if err := c.Store.save(ctx, k.c, stored{h: h, missing: missing, fetched: now}); err != nil {
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
func (c *Client) get(ctx context.Context, url string) (vals map[string][]float64, missing bool, wait time.Duration, err error) {
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
	vars := []string{"air_temperature_2m", "precipitation_amount", "relative_humidity_2m", "cloud_area_fraction", "wind_speed_10m",
		"integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time"}
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
	if v, ok := first(vals, "air_temperature_2m"); ok {
		h.TempC = round2(v - 273.15)
	}
	if v, ok := first(vals, "precipitation_amount"); ok {
		h.PrecipMM = round2(math.Max(v, 0))
	}
	if v, ok := first(vals, "relative_humidity_2m"); ok {
		h.HumidityPct = round2(math.Min(math.Max(v, 0), 1) * 100)
	}
	if v, ok := first(vals, "cloud_area_fraction"); ok {
		h.CloudPct = round2(math.Min(math.Max(v, 0), 1) * 100)
	}
	if v, ok := first(vals, "integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time"); ok {
		h.SunWM2 = round2(math.Max(v, 0) / 3600) // W s/m² over the hour
	}
	if v, ok := first(vals, "wind_speed_10m"); ok {
		h.WindMS = round2(math.Max(v, 0))
	}
	// A failed gust request keeps the analysis hour without its gust: expiry
	// asks a gust-less hour again for up to gustsFor. The wait still holds.
	h.GustMS, wait, err = c.gust(ctx, cell, t)
	if err != nil && ctx.Err() == nil {
		c.warn("weather gust failed", err)
		err = nil
	}
	return h, false, wait, err
}

// gust is the strongest gust in the hour before t at a cell, from the latest
// MEPS run in the archive that covers it with one of its first hours: runs
// start every 3 h and reach the archive hours late. One request reads a
// run's first hours at once, so the hours after reuse it. Nil when no run
// has it yet.
func (c *Client) gust(ctx context.Context, cell Cell, t time.Time) (*float64, time.Duration, error) {
	mc, ok := meps.cell(analysis.centre(cell))
	if !ok {
		return nil, 0, nil
	}
	run := t.Truncate(3 * time.Hour)
	for range 3 {
		lead := int(t.Sub(run) / time.Hour)
		gusts, wait, err := c.run(ctx, mc, run)
		if err != nil {
			return nil, wait, err
		}
		if lead < len(gusts) && !math.IsNaN(gusts[lead]) {
			return round2(gusts[lead]), 0, nil
		}
		if gusts != nil {
			return nil, 0, nil // the run is there, without this hour's gust
		}
		run = run.Add(-3 * time.Hour)
	}
	return nil, 0, nil
}

// runLeads are the lead hours read from a run: enough for an hour two runs back.
const runLeads = 9

// run is a MEPS run's gusts at a cell by lead hour, or nil when the archive
// does not have the run (yet).
func (c *Client) run(ctx context.Context, mc Cell, run time.Time) ([]float64, time.Duration, error) {
	k := runKey{mc, run.Unix() / 3600}
	now := c.now()
	c.mu.Lock()
	e, ok := c.runs[k]
	c.mu.Unlock()
	if ok && (e.expires.IsZero() || now.Before(e.expires)) {
		return e.gusts, 0, nil
	}
	select {
	case <-time.After(c.Interval):
	case <-ctx.Done():
		return nil, 0, ctx.Err()
	}
	at := fmt.Sprintf("%%5B0:%d%%5D%s", runLeads-1, index(0, mc.Y, mc.X))
	vals, missing, wait, err := c.get(ctx, fmt.Sprintf("%s/meps25epsarchive/%s/meps_det_2_5km_%s.nc.ascii?x_wind_gust_10m%s,y_wind_gust_10m%s",
		c.BaseURL, run.Format("2006/01/02"), run.Format("20060102T15Z"), at, at))
	if err != nil {
		return nil, wait, err
	}
	e = runEntry{expires: now.Add(missingTTL)}
	if !missing {
		// A vector in the grid's axes: its length is the gust speed.
		x, y := vals["x_wind_gust_10m"], vals["y_wind_gust_10m"]
		e = runEntry{gusts: make([]float64, min(len(x), len(y)))}
		for i := range e.gusts {
			e.gusts[i] = math.Hypot(x[i], y[i])
		}
	}
	c.mu.Lock()
	if len(c.runs) >= maxRuns {
		clear(c.runs)
	}
	c.runs[k] = e
	c.mu.Unlock()
	return e.gusts, 0, nil
}

// parseASCII reads an OPeNDAP ASCII response of grids: a line
// "name.name[n]..." followed by lines "[i]..., v[, v...]" holding the values
// in order, up to a blank line. NaN values stay NaN.
func parseASCII(r io.Reader) (map[string][]float64, error) {
	out := map[string][]float64{}
	sc := bufio.NewScanner(r)
	var grid string
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			grid = ""
			continue
		}
		if name, _, ok := strings.Cut(line, "."); ok && strings.HasPrefix(line[len(name)+1:], name+"[") {
			grid = name
			continue
		}
		if i := strings.LastIndex(line, "], "); grid != "" && strings.HasPrefix(line, "[") && i > 0 {
			for _, f := range strings.Split(line[i+3:], ", ") {
				v, err := strconv.ParseFloat(strings.TrimSpace(f), 64)
				if err != nil || math.IsInf(v, 0) {
					v = math.NaN()
				}
				out[grid] = append(out[grid], v)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("weather: no values in upstream response")
	}
	return out, nil
}

// first is a grid's first value, if it has one that is a number.
func first(vals map[string][]float64, name string) (float64, bool) {
	if v := vals[name]; len(v) > 0 && !math.IsNaN(v[0]) {
		return v[0], true
	}
	return 0, false
}
