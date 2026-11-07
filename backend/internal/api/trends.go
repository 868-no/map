package api

import (
	"context"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// ---- long-term trends (D-104) ----
//
// Views are derived in the browser from at most 14 days of rows (D-031); trends
// over the whole retained log are the exception: a few numbers per day, week
// or month, aggregated here because no browser should load months of rows.

type TrendsInput struct {
	Bucket string `query:"bucket" enum:"day,week,month" default:"day" doc:"Bucket length"`
	TZ     string `query:"tz" default:"UTC" doc:"IANA time zone the buckets start in, e.g. Europe/Oslo"`
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
	TZ       string        `json:"tz"`
	Since    *time.Time    `json:"since,omitempty" doc:"Oldest retained observation: the first bucket may be partial, and new_nodes counts from here"`
	Buckets  []TrendBucket `json:"buckets"`
	Computed time.Time     `json:"computed"`
}

type TrendsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         TrendsBody
}

// trendsCC lets browsers and shared caches (Cloudflare) reuse a trend for a
// quarter of an hour, and show it up to an hour longer while asking again:
// trends cover months in day, week and month buckets, so only the newest
// bucket can be behind, by minutes, and every visitor asks for the same few
// URLs.
const trendsCC = "public, max-age=900, stale-while-revalidate=3600"

// TrendsTTL is how long a computed trend is reused before the hourly
// summaries are refreshed again (D-112). Shorter than trendsCC's max-age, so
// a shared cache asking again gets a recent sum.
const TrendsTTL = 5 * time.Minute

// trendsCache keeps computed trends per bucket and time zone for TrendsTTL.
type trendsCache struct {
	mu    sync.Mutex
	byKey map[string]TrendsBody
}

func (c *trendsCache) get(key string, now time.Time) (TrendsBody, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.byKey[key]
	return b, ok && now.Sub(b.Computed) < TrendsTTL
}

// trendsMemoMax bounds the memo: any IANA zone can be asked for.
const trendsMemoMax = 64

// put keeps b (computed now), first dropping expired entries; when the memo
// is still full it drops the oldest.
func (c *trendsCache) put(key string, b TrendsBody) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		c.byKey = map[string]TrendsBody{}
	}
	if _, ok := c.byKey[key]; !ok && len(c.byKey) >= trendsMemoMax {
		oldest := ""
		for k, v := range c.byKey {
			if b.Computed.Sub(v.Computed) >= TrendsTTL {
				delete(c.byKey, k)
			} else if oldest == "" || v.Computed.Before(c.byKey[oldest].Computed) {
				oldest = k
			}
		}
		if len(c.byKey) >= trendsMemoMax {
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
	if err := s.trendHours.Warm(wctx, s.Pool, s.now()); err != nil && ctx.Err() == nil {
		s.Log.Warn("trends warm-up incomplete", "err", err)
	}
}

func (s *Server) trends(ctx context.Context, in *TrendsInput) (*TrendsOutput, error) {
	loc, ok := zone(in.TZ)
	if !ok {
		return nil, huma.Error400BadRequest("unknown time zone")
	}
	key := in.Bucket + "|" + in.TZ
	if b, ok := s.trendsMemo.get(key, s.now()); ok {
		return &TrendsOutput{CacheControl: trendsCC, Body: b}, nil
	}
	// Hourly summaries in memory keep this fast however long retention is
	// (D-112). They are refreshed at most once per TrendsTTL whatever bucket
	// or zone is asked for, so trends never compete with /observations for
	// read slots; a request in between only sums from memory.
	// The refresh outlives the request that started it: the first after a
	// start reads the whole retained log, which can take longer than a
	// request may, and is not wasted on a request deadline.
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), trendsRefreshLimit)
	defer cancel()
	if err := s.trendHours.RefreshEvery(rctx, s.Pool, s.now(), TrendsTTL); err != nil {
		return nil, err
	}
	body := TrendsBody{Bucket: in.Bucket, TZ: in.TZ, Buckets: []TrendBucket{}, Computed: s.now(), Since: s.trendHours.Oldest()}
	for _, b := range s.trendHours.Buckets(in.Bucket, loc) {
		body.Buckets = append(body.Buckets, TrendBucket{Start: b.Start, Nodes: b.Nodes, Gateways: b.Gateways, NewNodes: b.NewNodes, Packets: b.Packets, Receptions: b.Receptions, ByType: b.ByType})
	}
	s.trendsMemo.put(key, body)
	return &TrendsOutput{CacheControl: trendsCC, Body: body}, nil
}
