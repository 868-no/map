package query

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/window"
)

// bucketLadder are the allowed bucket widths; the smallest one yielding at
// most MaxBuckets buckets is chosen.
var bucketLadder = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}

// MaxBuckets bounds traffic responses.
const MaxBuckets = 600

// BucketFor picks the bucket width for a window, honouring a requested
// minimum if it is on the ladder.
func BucketFor(d time.Duration, requested time.Duration) time.Duration {
	for _, b := range bucketLadder {
		if b >= requested && int(d/b) <= MaxBuckets {
			return b
		}
	}
	return bucketLadder[len(bucketLadder)-1]
}

// Bucket is one time slice. Start is aligned to the window start.
type Bucket struct {
	Start      time.Time      `json:"start"`
	Packets    int            `json:"packets" doc:"unique logical packets first seen in this bucket"`
	Receptions int            `json:"receptions" doc:"distinct gateway receptions"`
	ByType     map[string]int `json:"by_type,omitempty"`
}

// Traffic is a bucketed traffic summary.
type Traffic struct {
	Bucket     string   `json:"bucket" example:"5m0s"`
	Buckets    []Bucket `json:"buckets"`
	Packets    int      `json:"packets"`
	Receptions int      `json:"receptions"`
}

// BuildTraffic counts unique packets (attributed to the bucket of their
// first in-window reception) separately from receptions, so several
// gateways hearing one packet never inflate packet counts.
func BuildTraffic(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, bucket time.Duration) (*Traffic, error) {
	b := where(w).filters(f)
	bw := b.arg(bucket)
	origin := b.arg(w.Start)
	rows, err := pool.Query(ctx, `
		WITH firsts AS (
			SELECT logical_packet_key, min(observed_at) AS t, min(packet_type) AS packet_type
			FROM packet_log WHERE `+b.String()+` GROUP BY 1
		), recs AS (
			SELECT date_bin(`+bw+`::interval, min(observed_at), `+origin+`::timestamptz) AS bkt
			FROM packet_log WHERE `+b.String()+` GROUP BY observation_key
		)
		SELECT bkt, NULL::text, 0, count(*) FROM recs GROUP BY bkt
		UNION ALL
		SELECT date_bin(`+bw+`::interval, t, `+origin+`::timestamptz), packet_type, count(*), 0 FROM firsts GROUP BY 1, 2
		ORDER BY 1`, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &Traffic{Bucket: bucket.String(), Buckets: []Bucket{}}
	idx := map[time.Time]int{}
	for rows.Next() {
		var at time.Time
		var typ *string
		var packets, recs int
		if err := rows.Scan(&at, &typ, &packets, &recs); err != nil {
			return nil, err
		}
		i, ok := idx[at]
		if !ok {
			i = len(out.Buckets)
			idx[at] = i
			out.Buckets = append(out.Buckets, Bucket{Start: at.UTC(), ByType: map[string]int{}})
		}
		bk := &out.Buckets[i]
		bk.Receptions += recs
		out.Receptions += recs
		if typ != nil {
			bk.Packets += packets
			bk.ByType[*typ] += packets
			out.Packets += packets
		}
	}
	return out, rows.Err()
}
