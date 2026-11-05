package terrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is Geonorge's height API (Kartverket's terrain model, CC BY 4.0).
const DefaultBaseURL = "https://ws.geonorge.no/hoydedata/v1"

// Attribution is what Kartverket's licence asks for.
const Attribution = "Terrain: © Kartverket"

const (
	perRequest = 50 // the API's limit
	// Points visitors may have waiting, all together and each: about 17
	// and 2 minutes of fetching. Visitors are served in turn, a point each,
	// so one asking for much delays others by little (D-147).
	maxQueue     = 200_000
	maxPerClient = 20_000
	// MaxPoints is the most distinct grid points one lookup may ask for:
	// 400 links averaging 50 km, more than the router links of any mesh in
	// Norway so far.
	MaxPoints       = 120_000
	maxEntries      = 2_000_000 // cached heights, about 50 MB
	defaultInterval = 250 * time.Millisecond
	defaultBackoff  = 30 * time.Second
	// Grid heights are snapped to: about 55 m north-south, 25 m east-west in
	// Norway, finer than the cross section's 200 m steps, so nearby links share them.
	gridDeg = 0.0005
)

// Key is a grid point; the store's primary key.
type Key struct{ Lat, Lon int32 }

func keyOf(p Point) Key {
	return Key{int32(math.Round(p.Lat / gridDeg)), int32(math.Round(p.Lon / gridDeg))}
}
func (k Key) point() Point { return Point{float64(k.Lat) * gridDeg, float64(k.Lon) * gridDeg} }

// Height is a grid point's terrain height; OK false where the model has none.
type Height struct {
	Z  float64
	OK bool
}

// Which queue holds a point (Client.queued); absent: neither.
const (
	inBackground uint8 = iota + 1
	inUrgent
)

// ErrTooManyPoints: one lookup asked for more than MaxPoints grid points.
var ErrTooManyPoints = errors.New("terrain: too many points")

// Client fetches heights in the background, one request at a time, and
// serves them from memory and the store. Create it with New; start Run.
type Client struct {
	HTTP      *http.Client
	BaseURL   string
	UserAgent string
	Interval  time.Duration
	Store     *Store
	Log       *slog.Logger

	mu    sync.Mutex
	cache map[Key]Height
	order []Key // insertion order, for eviction
	// Points to fetch: visitors' first, each visitor's in turn, then what
	// the warmer queued (D-147).
	urgent     map[string][]Key // per visitor (Protect's client key), in asking order
	turns      []string         // visitors with points waiting, next first
	nUrgent    int              // points in urgent
	background []Key
	queued     map[Key]uint8 // the furthest-forward queue holding the point
	wake       chan struct{}
}

func New(baseURL, userAgent string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{HTTP: &http.Client{Timeout: 30 * time.Second}, BaseURL: strings.TrimRight(baseURL, "/"), UserAgent: userAgent,
		Interval: defaultInterval, cache: map[Key]Height{}, urgent: map[string][]Key{}, queued: map[Key]uint8{}, wake: make(chan struct{}, 1)}
}

func (c *Client) warn(msg string, err error) {
	if c.Log != nil {
		c.Log.Warn(msg, "err", err)
	}
}

// Lookup is what one lookup found: the heights known when it was made.
type Lookup struct{ m map[Key]Height }

// At is the terrain height at p, or false where it is not known or the
// model has none.
func (l Lookup) At(p Point) (float64, bool) {
	h, ok := l.m[keyOf(p)]
	return h.Z, ok && h.OK
}

// Known reports whether p's grid point was looked up already, with or
// without a height: false while it is still being fetched.
func (l Lookup) Known(p Point) bool {
	_, ok := l.m[keyOf(p)]
	return ok
}

// Heights looks up points for an anonymous visitor; see HeightsFor.
func (c *Client) Heights(ctx context.Context, pts []Point) (func(Point) (float64, bool), bool) {
	l, incomplete, _ := c.HeightsFor(ctx, "", pts)
	return l.At, incomplete
}

// HeightsFor looks up points for one visitor: those known (memory, then
// store) are returned; the rest wait in the visitor's own queue, served in
// turn with other visitors' and ahead of the warmer's, and incomplete is
// true (D-147). More than MaxPoints distinct grid points is
// ErrTooManyPoints, and nothing is looked up.
func (c *Client) HeightsFor(ctx context.Context, client string, pts []Point) (Lookup, bool, error) {
	keys := dedupe(pts)
	if len(keys) > MaxPoints {
		return Lookup{}, false, ErrTooManyPoints
	}
	return c.lookup(ctx, client, keys)
}

// LinksFor is HeightsFor for the cross sections of links (Points of each
// pair of ends). Their distinct grid points are gathered link by link and
// the lookup is refused as soon as they pass MaxPoints, so a request for
// far more holds no more than that many at any time.
func (c *Client) LinksFor(ctx context.Context, client string, links [][2]Point) (Lookup, bool, error) {
	n := 0
	for _, l := range links {
		n += steps(l[0], l[1]) + 1 // len(Points(l[0], l[1]))
	}
	n = min(n, MaxPoints+1) // one more shows there are too many
	seen := make(map[Key]struct{}, n)
	keys := make([]Key, 0, n)
	for _, l := range links {
		eachPoint(l[0], l[1], func(p Point) {
			k := keyOf(p)
			if _, dup := seen[k]; dup || len(keys) > MaxPoints {
				return
			}
			seen[k] = struct{}{}
			keys = append(keys, k)
		})
		if len(keys) > MaxPoints {
			return Lookup{}, false, ErrTooManyPoints
		}
	}
	return c.lookup(ctx, client, keys)
}

// lookup is HeightsFor of distinct keys.
func (c *Client) lookup(ctx context.Context, client string, keys []Key) (Lookup, bool, error) {
	// A point waiting to be fetched was not in the store when it was queued,
	// and stays queued until it is stored (Run): not looked up again while
	// browsers re-poll.
	missing := c.unknown(keys)
	if len(missing) > 0 && c.Store != nil {
		got, err := c.Store.load(ctx, missing)
		if err != nil {
			c.warn("terrain store read failed", err)
		}
		c.mu.Lock()
		for k, h := range got {
			c.put(k, h)
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	incomplete := false
	snapshot := make(map[Key]Height, len(keys))
	for _, k := range keys {
		if h, ok := c.cache[k]; ok {
			snapshot[k] = h
			continue
		}
		incomplete = true
		// A point already waiting in the background queue is queued again in
		// front; the worker skips whichever copy comes second. One already
		// waiting for a visitor is not added again: browsers re-poll.
		if c.queued[k] < inUrgent && c.room(client) {
			if len(c.urgent[client]) == 0 {
				c.turns = append(c.turns, client)
			}
			c.urgent[client] = append(c.urgent[client], k)
			c.nUrgent++
			c.queued[k] = inUrgent
		}
	}
	c.mu.Unlock()
	if incomplete {
		c.poke()
	}
	return Lookup{snapshot}, incomplete, nil
}

// dedupe is the distinct grid points of pts, in order.
func dedupe(pts []Point) []Key {
	seen := make(map[Key]struct{}, len(pts))
	keys := make([]Key, 0, len(pts))
	for _, p := range pts {
		k := keyOf(p)
		if _, dup := seen[k]; !dup {
			seen[k] = struct{}{}
			keys = append(keys, k)
		}
	}
	return keys
}

func (c *Client) poke() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// uncached is the keys not in memory.
func (c *Client) uncached(keys []Key) []Key {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Key
	for _, k := range keys {
		if _, ok := c.cache[k]; !ok {
			out = append(out, k)
		}
	}
	return out
}

// unknown is the keys neither in memory nor queued: those the store may
// hold.
func (c *Client) unknown(keys []Key) []Key {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Key
	for _, k := range keys {
		if _, ok := c.cache[k]; !ok && c.queued[k] == 0 {
			out = append(out, k)
		}
	}
	return out
}

// room reports whether a visitor may queue another point: it holds fewer
// than maxPerClient, and the visitors' queue has room, or makes room by
// taking the last point of the visitor holding the most, when that one
// holds at least two more (as the weather queue does, D-141). c.mu is held.
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
		delete(c.queued, k) // a copy in the background queue goes too; the warmer queues it again
	}
	return true
}

// missing is which of keys have no height in memory or the store and are
// not waiting to be fetched: what the warmer should queue. waiting counts
// those without a height that are queued already. Without a store, memory
// decides.
func (c *Client) missing(ctx context.Context, keys []Key) (out []Key, waiting int, err error) {
	keys = c.uncached(keys)
	if len(keys) > 0 && c.Store != nil {
		if keys, err = c.Store.missing(ctx, keys); err != nil {
			return nil, 0, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range keys {
		if c.queued[k] == 0 {
			out = append(out, k)
		} else {
			waiting++
		}
	}
	return out, waiting, nil
}

// queueBackground queues points for the warmer, behind every visitor's.
func (c *Client) queueBackground(keys []Key) int {
	c.mu.Lock()
	n := 0
	for _, k := range keys {
		if c.queued[k] == 0 {
			c.background = append(c.background, k)
			c.queued[k] = inBackground
			n++
		}
	}
	c.mu.Unlock()
	if n > 0 {
		c.poke()
	}
	return n
}

// Waiting is how many points are queued for the worker.
func (c *Client) Waiting() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nUrgent + len(c.background)
}

// backgroundWaiting is how many points the warmer has waiting.
func (c *Client) backgroundWaiting() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.background)
}

// put stores a height in memory, dropping the oldest tenth when full.
// Callers hold mu.
func (c *Client) put(k Key, h Height) {
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
	c.cache[k] = h
}

// next takes up to perRequest points to fetch: one from each visitor in
// turn, then the warmer's to fill the request. keep says which a visitor
// asked for, to be kept in memory too. c.mu is held.
func (c *Client) next() (batch []Key, keep map[Key]bool) {
	keep = map[Key]bool{}
	take := func(k Key) {
		// Skip a copy whose point was fetched (through its other copy) or
		// loaded from the store since it was queued, or taken already.
		if _, taken := keep[k]; taken || c.queued[k] == 0 {
			return
		}
		if _, cached := c.cache[k]; cached {
			delete(c.queued, k)
			return
		}
		keep[k] = c.queued[k] == inUrgent || c.Store == nil
		batch = append(batch, k)
	}
	for len(batch) < perRequest && c.nUrgent > 0 {
		id := c.turns[0]
		q := c.urgent[id]
		k, q := q[0], q[1:]
		c.nUrgent--
		c.turns = c.turns[1:]
		if len(q) == 0 {
			delete(c.urgent, id)
		} else {
			c.urgent[id] = q
			c.turns = append(c.turns, id)
		}
		take(k)
	}
	for len(batch) < perRequest && len(c.background) > 0 {
		k := c.background[0]
		c.background = c.background[1:]
		take(k)
	}
	return batch, keep
}

// Run fetches queued points, up to the API's limit per request, until ctx
// ends. A point stays marked queued until it is stored, so the warmer does
// not queue it again in between.
func (c *Client) Run(ctx context.Context) {
	for {
		c.mu.Lock()
		batch, keep := c.next()
		c.mu.Unlock()
		if len(batch) == 0 {
			select {
			case <-c.wake:
				continue
			case <-ctx.Done():
				return
			}
		}
		got, wait, err := c.fetch(ctx, batch)
		c.mu.Lock()
		for k, h := range got {
			// Warmer-only points go to the store, not memory: they would
			// crowd out what visitors look at (D-147).
			if keep[k] {
				c.put(k, h)
			}
		}
		c.mu.Unlock()
		if err != nil {
			c.warn("terrain fetch failed", err)
		} else if c.Store != nil {
			if err := c.Store.save(ctx, got); err != nil {
				c.warn("terrain store write failed", err)
			}
		}
		c.mu.Lock()
		for _, k := range batch {
			delete(c.queued, k)
		}
		c.mu.Unlock()
		select {
		case <-time.After(max(wait, c.Interval)):
		case <-ctx.Done():
			return
		}
	}
}

// fetch asks the API for up to 50 points. At sea the model gives the depth;
// radio sees the surface, so sea counts as 0 m.
func (c *Client) fetch(ctx context.Context, keys []Key) (map[Key]Height, time.Duration, error) {
	pts := make([][2]float64, len(keys))
	for i, k := range keys {
		p := k.point()
		pts[i] = [2]float64{math.Round(p.Lon*1e5) / 1e5, math.Round(p.Lat*1e5) / 1e5}
	}
	js, _ := json.Marshal(pts)
	q := url.Values{"koordsys": {"4258"}, "geojson": {"false"}, "punkter": {string(js)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/punkt?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, err
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		wait := defaultBackoff
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 {
			wait = time.Duration(s) * time.Second
		}
		io.CopyN(io.Discard, resp.Body, 64<<10) //nolint:errcheck // lets the connection be reused
		return nil, wait, fmt.Errorf("terrain: upstream status %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		io.CopyN(io.Discard, resp.Body, 64<<10) //nolint:errcheck // lets the connection be reused
		return nil, 0, fmt.Errorf("terrain: upstream status %d", resp.StatusCode)
	}
	var body struct {
		Punkter []struct {
			Z       *float64 `json:"z"`
			Terreng *string  `json:"terreng"`
		} `json:"punkter"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, 0, err
	}
	if len(body.Punkter) != len(keys) {
		return nil, 0, fmt.Errorf("terrain: %d heights for %d points", len(body.Punkter), len(keys))
	}
	out := make(map[Key]Height, len(keys))
	for i, p := range body.Punkter {
		switch {
		case p.Z == nil:
			out[keys[i]] = Height{}
		case p.Terreng != nil && *p.Terreng == "Havflate":
			out[keys[i]] = Height{Z: 0, OK: true}
		default:
			out[keys[i]] = Height{Z: math.Round(*p.Z*10) / 10, OK: true}
		}
	}
	return out, 0, nil
}

// Profile builds the cross section from a to b with what is known now, for
// an anonymous visitor; see ProfileFor.
func (c *Client) Profile(ctx context.Context, a, b End) (Profile, bool) {
	return c.ProfileFor(ctx, "", a, b)
}

// ProfileFor builds the cross section from a to b with what is known now;
// incomplete when heights are still being fetched for this visitor.
func (c *Client) ProfileFor(ctx context.Context, client string, a, b End) (Profile, bool) {
	l, incomplete, err := c.HeightsFor(ctx, client, Points(a.Point, b.Point))
	if err != nil { // over MaxPoints: longer than MaxLengthM allows
		return Profile{Class: "unknown", LengthM: math.Round(Distance(a.Point, b.Point))}, false
	}
	p := Build(a, b, l.At)
	if incomplete {
		p.Class = "unknown"
	}
	return p, incomplete
}
