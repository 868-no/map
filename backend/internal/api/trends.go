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

// TrendsTTL is how long a computed trend is reused: each one scans the log.
const TrendsTTL = 10 * time.Minute

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
	// Invalid rows (failed verification, D-093) may carry a forged sender: never counted.
	rows, err := s.Pool.Query(ctx, `
		WITH t AS (
		  SELECT date_trunc($1, observed_at AT TIME ZONE $2) AS b, source_node_id, gateway_node_id, logical_packet_key,
		    -- Rows stored before these apps were decoded, labelled as the rows clients get (D-103).
		    CASE WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'STORE_FORWARD_APP' THEN 'store_forward'
		         WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'NODE_STATUS_APP' THEN 'node_status'
		         ELSE packet_type END AS packet_type
		  FROM packet_log WHERE packet_type <> 'invalid'),
		firsts AS (SELECT min(b) AS b FROM t GROUP BY source_node_id),
		totals AS (SELECT b, count(DISTINCT source_node_id) n, count(DISTINCT gateway_node_id) g, count(DISTINCT logical_packet_key) p, count(*) r FROM t GROUP BY b),
		news AS (SELECT b, count(*) c FROM firsts GROUP BY b),
		types AS (SELECT b, jsonb_object_agg(packet_type, c) j FROM (SELECT b, packet_type, count(DISTINCT logical_packet_key) c FROM t GROUP BY b, packet_type) x GROUP BY b)
		SELECT totals.b, n, g, COALESCE(news.c, 0), p, r, COALESCE(types.j, '{}'::jsonb)
		FROM totals LEFT JOIN news USING (b) LEFT JOIN types USING (b) ORDER BY totals.b`, in.Bucket, in.TZ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	loc, _ := time.LoadLocation(in.TZ)
	for rows.Next() {
		var tb TrendBucket
		var local time.Time
		if err := rows.Scan(&local, &tb.Nodes, &tb.Gateways, &tb.NewNodes, &tb.Packets, &tb.Receptions, &tb.ByType); err != nil {
			return nil, err
		}
		// date_trunc of a local timestamp: wall-clock fields in the zone.
		tb.Start = time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, loc)
		body.Buckets = append(body.Buckets, tb)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.Pool.QueryRow(ctx, `SELECT min(observed_at) FROM packet_log`).Scan(&body.Since); err != nil {
		return nil, err
	}
	s.trendsMemo.put(key, body)
	return &TrendsOutput{CacheControl: "public, max-age=300", Body: body}, nil
}
