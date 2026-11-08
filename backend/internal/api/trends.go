package api

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/storage"
)

// ---- long-term trends (D-104) ----
//
// Views are derived in the browser from at most 14 days of rows (D-031); trends
// over the whole retained log are the exception: a few numbers per day, week
// or month, aggregated here because no browser should load months of rows.

type TrendsInput struct {
	Bucket string `query:"bucket" enum:"day,week,month" default:"day" doc:"Bucket length"`
	TZ     string `query:"tz" default:"UTC" doc:"IANA time zone the buckets start in, e.g. Europe/Oslo"`
	Region string `query:"region" doc:"Only rows uplinked under an MQTT topic root naming this region (Nord-Norge, Trøndelag, Vestlandet, Østlandet or Sørlandet); by_type is then empty (D-194)"`
}

type TrendBucket struct {
	Start      time.Time      `json:"start" doc:"Bucket start in the requested time zone"`
	Nodes      int            `json:"nodes" doc:"Distinct nodes heard (senders)"`
	Gateways   int            `json:"gateways" doc:"Distinct gateways that uplinked anything"`
	NewNodes   int            `json:"new_nodes" doc:"Nodes first heard in this bucket (within retention)"`
	Packets    int            `json:"packets" doc:"Distinct packets"`
	Receptions int            `json:"receptions" doc:"Gateway receptions of them"`
	ByType     map[string]int `json:"by_type" doc:"Distinct packets by type"`
}

type TrendsBody struct {
	Bucket   string        `json:"bucket"`
	Since    *time.Time    `json:"since,omitempty" doc:"Oldest retained observation: the first bucket may be partial, and new_nodes counts from here"`
	Buckets  []TrendBucket `json:"buckets"`
	Computed time.Time     `json:"-"` // for the response cache's expiry
}

type TrendsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         TrendsBody
}

// trendsCC lets browsers and shared caches (Cloudflare) reuse a trend for an
// hour, and show it up to a day longer while asking again: trends cover
// months in day, week and month buckets, so only the newest bucket can be
// behind, by at most about an hour, which nobody reading months notices; and
// every visitor asks for the same few URLs.
const trendsCC = "public, max-age=3600, stale-while-revalidate=86400"

// TrendsTTL is how long a computed trend is reused before the hourly
// summaries are refreshed again (D-112). Shorter than trendsCC's max-age, so
// a shared cache asking again gets a recent sum.
const TrendsTTL = 5 * time.Minute

// trendsCache keeps computed trends per key (bucket, time zone, region or
// node) for TrendsTTL. Mesh-wide and per-node trends keep one each, so
// viewers browsing nodes never push the few mesh-wide answers out.
type trendsCache[B interface{ computedAt() time.Time }] struct {
	mu    sync.Mutex
	max   int // entries kept at most; 0: trendsMemoMax
	byKey map[string]B
}

func (b TrendsBody) computedAt() time.Time      { return b.Computed }
func (b NodeTrendsBody) computedAt() time.Time  { return b.Computed }
func (b FleetTrendsBody) computedAt() time.Time { return b.Computed }

func (c *trendsCache[B]) get(key string, now time.Time) (B, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.byKey[key]
	return b, ok && now.Sub(b.computedAt()) < TrendsTTL
}

// trendsMemoMax bounds the mesh-wide memo: any IANA zone can be asked for.
const trendsMemoMax = 64

// put keeps b (computed now), first dropping expired entries; when the memo
// is still full it drops the oldest.
func (c *trendsCache[B]) put(key string, b B) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		c.byKey = map[string]B{}
	}
	limit := c.max
	if limit == 0 {
		limit = trendsMemoMax
	}
	if _, ok := c.byKey[key]; !ok && len(c.byKey) >= limit {
		oldest := ""
		for k, v := range c.byKey {
			if b.computedAt().Sub(v.computedAt()) >= TrendsTTL {
				delete(c.byKey, k)
			} else if oldest == "" || v.computedAt().Before(c.byKey[oldest].computedAt()) {
				oldest = k
			}
		}
		if len(c.byKey) >= limit {
			delete(c.byKey, oldest)
		}
	}
	c.byKey[key] = b
}

// zones caches parsed time zones: LoadLocation reads tzdata each time.
var zones sync.Map

func zone(name string) (*time.Location, bool) {
	if l, ok := zones.Load(name); ok {
		return l.(*time.Location), true
	}
	if name == "" || name == "Local" {
		return nil, false
	}
	l, err := time.LoadLocation(name)
	if err != nil {
		return nil, false
	}
	zones.Store(name, l)
	return l, true
}

// trendsRefreshLimit bounds one refresh of the hourly summaries.
const trendsRefreshLimit = 2 * time.Minute

// WarmTrends reads the hourly summaries once at start, so the first visitor
// to ask for trends does not wait for the whole retained log to be read.
func (s *Server) WarmTrends(ctx context.Context) {
	wctx, cancel := context.WithTimeout(ctx, trendsRefreshLimit)
	defer cancel()
	// Not when the server is stopping; a warm-up cut short by its own limit is
	// worth knowing about (the first request carries on from where it got).
	if err := s.trendHours.Warm(wctx, s.background(), s.now()); err != nil && ctx.Err() == nil {
		s.Log.Warn("trends warm-up incomplete", "err", err)
	}
}

func (s *Server) trends(ctx context.Context, in *TrendsInput) (*TrendsOutput, error) {
	loc, ok := zone(in.TZ)
	if !ok {
		return nil, huma.Error400BadRequest("unknown time zone")
	}
	if in.Region != "" && !slices.Contains(storage.Regions, in.Region) {
		return nil, huma.Error400BadRequest("unknown region")
	}
	key := in.Bucket + "|" + in.TZ + "|" + in.Region
	if b, ok := s.trendsMemo.get(key, s.now()); ok {
		return &TrendsOutput{CacheControl: trendsCC, Body: b}, nil
	}
	fresh, err := s.refreshTrends(ctx)
	if err != nil {
		return nil, err
	}
	body := TrendsBody{Bucket: in.Bucket, Buckets: []TrendBucket{}, Computed: s.now(), Since: s.trendHours.Oldest()}
	for _, b := range s.trendHours.Buckets(in.Bucket, loc, in.Region) {
		body.Buckets = append(body.Buckets, TrendBucket{Start: b.Start, Nodes: b.Nodes, Gateways: b.Gateways, NewNodes: b.NewNodes, Packets: b.Packets, Receptions: b.Receptions, ByType: b.ByType})
	}
	if !fresh {
		// The previous refresh's sums, while the next one runs: neither
		// kept nor shared, so the next request has the fresh ones.
		return &TrendsOutput{CacheControl: "no-store", Body: body}, nil
	}
	s.trendsMemo.put(key, body)
	return &TrendsOutput{CacheControl: trendsCC, Body: body}, nil
}

// trendsWaitStale is how long a request waits for a refresh when the sums
// of an earlier one can answer it meanwhile.
const trendsWaitStale = 2 * time.Second

// refreshTrends brings the hourly summaries up to date, at most once per
// TrendsTTL whatever bucket or zone is asked for, so trends never compete
// with /observations for read slots and a request in between only sums from
// memory (D-112). One refresh runs at a time, on its own: the first after a
// start reads the whole retained log, which can take longer than a request
// may, and is not wasted on a request deadline. A request waits for it only
// as long as its own context allows, and no more than trendsWaitStale when a
// completed refresh's sums can answer instead (fresh is then false); with
// none to answer, a request out of time is answered 503.
func (s *Server) refreshTrends(ctx context.Context) (fresh bool, err error) {
	if s.trendHours.Fresh(TrendsTTL) {
		return true, nil
	}
	ch := s.trendsFlight.DoChan("refresh", func() (any, error) {
		rctx, cancel := context.WithTimeout(context.Background(), trendsRefreshLimit)
		defer cancel()
		if s.trendsRefresh != nil {
			return nil, s.trendsRefresh(rctx)
		}
		return nil, s.trendHours.RefreshEvery(rctx, s.background(), s.now(), TrendsTTL)
	})
	stale := s.trendHours.Complete()
	wait := ctx
	if stale {
		var cancel context.CancelFunc
		wait, cancel = context.WithTimeout(ctx, trendsWaitStale)
		defer cancel()
	}
	select {
	case r := <-ch:
		if r.Err == nil {
			return true, nil
		}
		if stale && ctx.Err() == nil {
			s.Log.Warn("trends refresh failed; answering from the previous sums", "err", r.Err)
			return false, nil
		}
		return false, r.Err
	case <-wait.Done():
		switch {
		case ctx.Err() == nil: // waited long enough: the previous sums answer
			return false, nil
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return false, huma.Error503ServiceUnavailable("trends are still being computed, retry shortly")
		}
		return false, ctx.Err()
	}
}

// ---- one node's long-term history (D-195) ----
//
// The window shows a node over at most 14 days; whether it has got worse
// since it was moved takes months. Its figures come from the same hourly
// summaries as the mesh-wide trends, so this never reads the log.

type NodeTrendsInput struct {
	ID     string `path:"id" doc:"Node id, !xxxxxxxx or decimal" example:"!98644b01"`
	Bucket string `query:"bucket" enum:"day,week,month" default:"day" doc:"Bucket length"`
	TZ     string `query:"tz" default:"UTC" doc:"IANA time zone the buckets start in, e.g. Europe/Oslo"`
}

type NodeTrendBucket struct {
	Start            time.Time `json:"start" doc:"Bucket start in the requested time zone"`
	Hours            int       `json:"hours" doc:"Hours of the bucket in which anything at all was logged (hours the collector heard nothing are not held against the node)"`
	HoursHeard       int       `json:"hours_heard" doc:"Of those, hours in which the node sent anything"`
	HoursGateway     int       `json:"hours_gateway" doc:"Of those, hours in which it uplinked anything as a gateway"`
	Packets          int       `json:"packets" doc:"Its distinct packets"`
	Receptions       int       `json:"receptions" doc:"Receptions of them by other gateways (its own uplinks of them left out)"`
	ReceptionsPerPkt *float64  `json:"receptions_per_packet,omitempty" doc:"Receptions divided by packets: how many other gateways heard each of its packets on average (the reach of its signal); absent without packets"`
	BatteryMin       *int      `json:"battery_min,omitempty" doc:"Lowest battery level (%) its device telemetry reported; 101 means it reported only external power; absent when it reported none"`
}

type NodeTrendsBody struct {
	Node     string            `json:"node" example:"!98644b01"`
	Bucket   string            `json:"bucket"`
	Since    *time.Time        `json:"since,omitempty" doc:"Oldest retained observation: nothing older is known"`
	Buckets  []NodeTrendBucket `json:"buckets" doc:"From the bucket it was first heard in (as a sender or gateway) to the newest, those it was silent in included"`
	Computed time.Time         `json:"-"` // for the response cache's expiry
}

type NodeTrendsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         NodeTrendsBody
}

// nodeTrendsMemoMax bounds the per-node memo: a few hundred nodes, each in
// three bucket lengths, mostly in one zone.
const nodeTrendsMemoMax = 512

func (s *Server) nodeTrends(ctx context.Context, in *NodeTrendsInput) (*NodeTrendsOutput, error) {
	n, ok := protocol.ParseNodeID(in.ID)
	if !ok || !protocol.ValidNode(n) {
		return nil, huma.Error400BadRequest("invalid node id")
	}
	loc, ok := zone(in.TZ)
	if !ok {
		return nil, huma.Error400BadRequest("unknown time zone")
	}
	node := protocol.NodeID(n)
	key := node + "|" + in.Bucket + "|" + in.TZ
	if b, ok := s.nodeTrendsMemo.get(key, s.now()); ok {
		return &NodeTrendsOutput{CacheControl: trendsCC, Body: b}, nil
	}
	fresh, err := s.refreshTrends(ctx)
	if err != nil {
		return nil, err
	}
	buckets, heard := s.trendHours.NodeBuckets(int64(n), in.Bucket, loc)
	if !heard {
		return nil, huma.Error404NotFound("node not heard in the retained log")
	}
	body := NodeTrendsBody{Node: node, Bucket: in.Bucket, Buckets: make([]NodeTrendBucket, 0, len(buckets)), Computed: s.now(), Since: s.trendHours.Oldest()}
	for _, b := range buckets {
		o := NodeTrendBucket{Start: b.Start, Hours: b.Hours, HoursHeard: b.HoursHeard, HoursGateway: b.HoursGateway, Packets: b.Packets, Receptions: b.Receptions}
		if b.Packets > 0 {
			r := float64(b.Receptions) / float64(b.Packets)
			o.ReceptionsPerPkt = &r
		}
		if b.Battery != storage.NoBattery {
			v := b.Battery
			o.BatteryMin = &v
		}
		body.Buckets = append(body.Buckets, o)
	}
	if !fresh {
		// As for /trends: the previous refresh's sums, neither kept nor shared.
		return &NodeTrendsOutput{CacheControl: "no-store", Body: body}, nil
	}
	s.nodeTrendsMemo.put(key, body)
	return &NodeTrendsOutput{CacheControl: trendsCC, Body: body}, nil
}
