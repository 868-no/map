package api

import (
	"context"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// ---- long-term trends (D-104) ----
//
// Views are derived in the browser from at most a week of rows (D-031); trends
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

// TrendsTTL is how long a computed trend is reused before the hourly
// summaries are refreshed again (D-112).
const TrendsTTL = time.Minute

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

func (c *trendsCache) put(key string, b TrendsBody) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		c.byKey = map[string]TrendsBody{}
	}
	c.byKey[key] = b
}

func (s *Server) trends(ctx context.Context, in *TrendsInput) (*TrendsOutput, error) {
	if _, err := time.LoadLocation(in.TZ); err != nil || in.TZ == "" || in.TZ == "Local" {
		return nil, huma.Error400BadRequest("unknown time zone")
	}
	key := in.Bucket + "|" + in.TZ
	if b, ok := s.trendsMemo.get(key, s.now()); ok {
		return &TrendsOutput{CacheControl: "public, max-age=300", Body: b}, nil
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()

	body := TrendsBody{Bucket: in.Bucket, TZ: in.TZ, Buckets: []TrendBucket{}, Computed: s.now()}
	// Hourly summaries in memory keep this fast however long retention is (D-112).
	if err := s.trendHours.Refresh(ctx, s.Pool, s.now()); err != nil {
		return nil, err
	}
	loc, _ := time.LoadLocation(in.TZ)
	for _, b := range s.trendHours.Buckets(in.Bucket, loc) {
		body.Buckets = append(body.Buckets, TrendBucket{Start: b.Start, Nodes: b.Nodes, Gateways: b.Gateways, NewNodes: b.NewNodes, Packets: b.Packets, Receptions: b.Receptions, ByType: b.ByType})
	}
	if err := s.Pool.QueryRow(ctx, `SELECT min(observed_at) FROM packet_log`).Scan(&body.Since); err != nil {
		return nil, err
	}
	s.trendsMemo.put(key, body)
	return &TrendsOutput{CacheControl: "public, max-age=300", Body: body}, nil
}
