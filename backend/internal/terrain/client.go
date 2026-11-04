package terrain

import (
	"context"
	"encoding/json"
	"fmt"
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
	perRequest      = 50 // the API's limit
	maxQueue        = 200_000
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

// Client fetches heights in the background, one request at a time, and
// serves them from memory and the store. Create it with New; start Run.
type Client struct {
	HTTP      *http.Client
	BaseURL   string
	UserAgent string
	Interval  time.Duration
	Store     *Store
	Log       *slog.Logger

	mu     sync.Mutex
	cache  map[Key]Height
	queue  []Key
	queued map[Key]bool
	wake   chan struct{}
}

func New(baseURL, userAgent string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{HTTP: &http.Client{Timeout: 30 * time.Second}, BaseURL: strings.TrimRight(baseURL, "/"), UserAgent: userAgent,
		Interval: defaultInterval, cache: map[Key]Height{}, queued: map[Key]bool{}, wake: make(chan struct{}, 1)}
}

func (c *Client) warn(msg string, err error) {
	if c.Log != nil {
		c.Log.Warn(msg, "err", err)
	}
}

// Heights looks up points: those known (memory, then store) are returned;
// the rest are queued for the worker and incomplete is true.
func (c *Client) Heights(ctx context.Context, pts []Point) (func(Point) (float64, bool), bool) {
	keys := make([]Key, 0, len(pts))
	for _, p := range pts {
		keys = append(keys, keyOf(p))
	}
	c.mu.Lock()
	var missing []Key
	for _, k := range keys {
		if _, ok := c.cache[k]; !ok {
			missing = append(missing, k)
		}
	}
	c.mu.Unlock()
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
	for _, k := range keys {
		if _, ok := c.cache[k]; !ok {
			incomplete = true
			if !c.queued[k] && len(c.queue) < maxQueue {
				c.queued[k] = true
				c.queue = append(c.queue, k)
			}
		}
	}
	snapshot := make(map[Key]Height, len(keys))
	for _, k := range keys {
		if h, ok := c.cache[k]; ok {
			snapshot[k] = h
		}
	}
	c.mu.Unlock()
	if incomplete {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	return func(p Point) (float64, bool) {
		h, ok := snapshot[keyOf(p)]
		return h.Z, ok && h.OK
	}, incomplete
}

// put stores a height in memory, starting over when full. Callers hold mu.
func (c *Client) put(k Key, h Height) {
	if len(c.cache) >= maxEntries {
		clear(c.cache)
	}
	c.cache[k] = h
}

// Run fetches queued points, up to the API's limit per request, until ctx ends.
func (c *Client) Run(ctx context.Context) {
	for {
		c.mu.Lock()
		n := min(perRequest, len(c.queue))
		batch := append([]Key(nil), c.queue[:n]...)
		c.queue = c.queue[n:]
		c.mu.Unlock()
		if n == 0 {
			select {
			case <-c.wake:
				continue
			case <-ctx.Done():
				return
			}
		}
		got, wait, err := c.fetch(ctx, batch)
		c.mu.Lock()
		for _, k := range batch {
			delete(c.queued, k)
		}
		for k, h := range got {
			c.put(k, h)
		}
		c.mu.Unlock()
		if err != nil {
			c.warn("terrain fetch failed", err)
		} else if c.Store != nil {
			if err := c.Store.save(ctx, got); err != nil {
				c.warn("terrain store write failed", err)
			}
		}
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
		return nil, wait, fmt.Errorf("terrain: upstream status %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
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

// Profile builds the cross section from a to b with what is known now;
// incomplete when heights are still being fetched.
func (c *Client) Profile(ctx context.Context, a, b End) (Profile, bool) {
	height, incomplete := c.Heights(ctx, Points(a.Point, b.Point))
	p := Build(a, b, height)
	if incomplete {
		p.Class = "unknown"
	}
	return p, incomplete
}
