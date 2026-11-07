package storage

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/window"
)

// TrendRecent is how far back every refresh recomputes hours: copies of a
// packet keep arriving for a while, and broker provenance is merged late.
const TrendRecent = 2 * time.Hour

// trendChunk bounds one refresh query.
const trendChunk = 24 * time.Hour

// HourSummary is one UTC hour of the log, as trends need it (D-112).
type HourSummary struct {
	Nodes, Gateways     []int64 // distinct, sorted
	Packets, Receptions int
	ByType              map[string]int
	DecodeVersion       int
	// Per region (landsdel) its MQTT topic root names, of the rows uplinked
	// under such a topic (D-194).
	Regions map[string]RegionHour
}

// RegionHour is one hour of one region's rows: those uplinked under a topic
// root naming it.
type RegionHour struct {
	Nodes      []int64 `json:"n"` // distinct senders, sorted
	Gateways   []int64 `json:"g"` // distinct gateways, sorted
	Packets    int     `json:"p"`
	Receptions int     `json:"r"`
}

// Regions are the landsdeler a topic root can name (as the engine's
// landsdel::NAMES and the map's Regions layer).
var Regions = []string{"Nord-Norge", "Trøndelag", "Vestlandet", "Østlandet", "Sørlandet"}

// TrendHours keeps per-hour summaries of the retained log in memory (D-112),
// so long-term trends never scan the whole log after the first request:
// no summary table is added (invariant 2), and a restart costs one
// scan. Daily, weekly and monthly totals in any whole-hour time zone are
// unions of hours.
type TrendHours struct {
	mu     sync.Mutex
	hours  map[time.Time]*HourSummary
	oldest *time.Time // the oldest retained row at the last refresh
	last   time.Time  // wall clock of the last refresh
	// The highest packet_log id at the last refresh and at the one before:
	// ids come from a sequence, so rows stored since then, in whatever hour
	// (imported history), have higher ids (D-151).
	seenID, olderID int64
}

// Rows that failed verification never count (D-093); rows stored as "other"
// before node status and store-and-forward were decoded count as those (D-103).
var trendRangeSQL = `
	WITH r AS (
	  SELECT date_trunc('hour', observed_at) AS h, source_node_id AS s, gateway_node_id AS g, logical_packet_key AS l, decode_version AS dv,
	    substring(mqtt_topic from '/(Nord-Norge|Trøndelag|Vestlandet|Østlandet|Sørlandet)(?:/|$)') AS reg,
	    CASE WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'STORE_FORWARD_APP' THEN 'store_forward'
	         WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'NODE_STATUS_APP' THEN 'node_status'
	         ELSE packet_type END AS ty
	  FROM packet_log WHERE ` + window.Predicate(1, 2) + ` AND packet_type <> 'invalid'),
	agg AS (SELECT h, array_agg(DISTINCT s ORDER BY s) AS nodes, array_remove(array_agg(DISTINCT g ORDER BY g), NULL) AS gws, count(DISTINCT l) AS p, count(*) AS rc, bool_or(dv < $3) AS stale FROM r GROUP BY h),
	types AS (SELECT h, jsonb_object_agg(ty, c) AS j FROM (SELECT h, ty, count(DISTINCT l) AS c FROM r GROUP BY h, ty) x GROUP BY h),
	regs AS (SELECT h, jsonb_object_agg(reg, jsonb_build_object('n', nodes, 'g', gws, 'p', p, 'r', rc)) AS j FROM (
	  SELECT h, reg, array_agg(DISTINCT s ORDER BY s) AS nodes, array_remove(array_agg(DISTINCT g ORDER BY g), NULL) AS gws, count(DISTINCT l) AS p, count(*) AS rc
	  FROM r WHERE reg IS NOT NULL GROUP BY h, reg) x GROUP BY h)
	SELECT agg.h, agg.nodes, agg.gws, agg.p, agg.rc, COALESCE(types.j, '{}'::jsonb), agg.stale, COALESCE(regs.j, '{}'::jsonb) FROM agg LEFT JOIN types USING (h) LEFT JOIN regs USING (h)`

// Refresh brings the summaries up to date: hours never summed, the most
// recent TrendRecent, hours summed under an older decoder, and every hour
// that has gained rows since the refresh before last (an import of history,
// anywhere in the range) are read from the log again; hours before the
// oldest retained row are dropped, so the totals never outlive the data.
//
// New rows are found by id, which comes from a sequence: one look per
// partition at the primary key's tail. Ids are taken at insert but become
// visible at commit, so the look goes back to the refresh before last: a
// batch still uncommitted at one refresh is caught by the next one (after
// the first refresh, which reads everything, only in the recent hours).
func (t *TrendHours) Refresh(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.refresh(ctx, pool, now)
}

// refresh is Refresh with t.mu held.
func (t *TrendHours) refresh(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	if t.hours == nil {
		t.hours = map[time.Time]*HourSummary{}
	}
	var oldest, newest *time.Time
	var maxID *int64
	if err := pool.QueryRow(ctx, `SELECT min(observed_at), max(observed_at), max(id) FROM packet_log`).Scan(&oldest, &newest, &maxID); err != nil {
		return err
	}
	t.oldest = oldest
	if oldest == nil {
		t.hours = map[time.Time]*HourSummary{}
		t.seenID, t.olderID = 0, 0
		t.last = time.Now()
		return nil
	}
	first := oldest.UTC().Truncate(time.Hour)
	var last, stale time.Time
	for h, s := range t.hours {
		if h.Before(first) {
			delete(t.hours, h)
			continue
		}
		if h.After(last) {
			last = h
		}
		if s.DecodeVersion < ingest.DecodeVersion && (stale.IsZero() || h.Before(stale)) {
			stale = h
		}
	}
	if newest.After(now) {
		now = *newest // a clock behind the data (tests): still sum every row
	}
	end := now.UTC().Truncate(time.Hour).Add(time.Hour)
	from := end.Add(-TrendRecent)
	switch {
	case last.IsZero():
		from = first
	case !stale.IsZero() && stale.Before(from):
		from = stale
	case last.Before(from):
		from = last
	}
	if from.Before(first) {
		from = first
	}
	if !last.IsZero() && t.seenID > 0 {
		// Hours before from that gained rows: read each run of them again.
		hours, err := t.changedHours(ctx, pool, t.olderID, first, from)
		if err != nil {
			return err
		}
		for i := 0; i < len(hours); {
			j := i + 1
			for j < len(hours) && hours[j].Equal(hours[j-1].Add(time.Hour)) {
				j++
			}
			if err := t.readChunks(ctx, pool, hours[i], hours[j-1].Add(time.Hour)); err != nil {
				return err
			}
			i = j
		}
	}
	if err := t.readChunks(ctx, pool, from, end); err != nil {
		return err
	}
	m := int64(0)
	if maxID != nil {
		m = *maxID
	}
	if t.seenID == 0 {
		t.olderID = m // everything up to here was just read
	} else {
		t.olderID = t.seenID
	}
	t.seenID = m
	// Fresh only once complete: a refresh cut short (an error, the request
	// ending) leaves the hours it read, and the next request carries on
	// from the last of them instead of serving partial sums as fresh.
	t.last = time.Now()
	return nil
}

// changedHours lists, oldest first, the UTC hours in [lo, hi) holding rows
// with an id above `above`.
func (t *TrendHours) changedHours(ctx context.Context, pool *pgxpool.Pool, above int64, lo, hi time.Time) ([]time.Time, error) {
	rows, err := pool.Query(ctx, `SELECT DISTINCT date_trunc('hour', observed_at) AS h FROM packet_log
		WHERE id > $1 AND `+window.Predicate(2, 3)+` ORDER BY h`, above, lo, hi)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []time.Time
	for rows.Next() {
		var h time.Time
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out = append(out, h.UTC())
	}
	return out, rows.Err()
}

// readChunks reads [lo, hi) a trendChunk at a time.
func (t *TrendHours) readChunks(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time) error {
	for ; lo.Before(hi); lo = lo.Add(trendChunk) {
		next := lo.Add(trendChunk)
		if next.After(hi) {
			next = hi
		}
		if err := t.readRange(ctx, pool, lo, next); err != nil {
			return err
		}
	}
	return nil
}

func (t *TrendHours) readRange(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time) error {
	rows, err := pool.Query(ctx, trendRangeSQL, lo, hi, ingest.DecodeVersion)
	if err != nil {
		return err
	}
	defer rows.Close()
	fresh := map[time.Time]*HourSummary{}
	for rows.Next() {
		var h time.Time
		s := &HourSummary{DecodeVersion: ingest.DecodeVersion}
		var stale bool
		if err := rows.Scan(&h, &s.Nodes, &s.Gateways, &s.Packets, &s.Receptions, &s.ByType, &stale, &s.Regions); err != nil {
			return err
		}
		if stale {
			// Some rows are still to be decoded again: read this hour again later.
			s.DecodeVersion = 0
		}
		fresh[h.UTC()] = s
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for h := lo; h.Before(hi); h = h.Add(time.Hour) {
		delete(t.hours, h)
	}
	for h, s := range fresh {
		t.hours[h] = s
	}
	return nil
}

// RefreshEvery refreshes at most once per every (wall clock): requests in
// between, whatever bucket or zone they ask for, reuse the summaries. The
// look and the refresh share the lock, so requests arriving while one
// refreshes wait for it and then find the summaries fresh, instead of each
// reading the log again in turn; if it failed, the next one carries it on.
func (t *TrendHours) RefreshEvery(ctx context.Context, pool *pgxpool.Pool, now time.Time, every time.Duration) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.hours != nil && time.Since(t.last) < every {
		return nil
	}
	return t.refresh(ctx, pool, now)
}

// Warm reads the summaries without counting them fresh: the first request
// still looks again, but only at what arrived since (an empty log at start
// must not answer for the next every).
func (t *TrendHours) Warm(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	err := t.refresh(ctx, pool, now)
	t.last = time.Time{}
	return err
}

// Oldest is the oldest retained row as of the last refresh (nil: none).
func (t *TrendHours) Oldest() *time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.oldest
}

// Len is how many hours are summarised.
func (t *TrendHours) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.hours)
}

// Hour returns a copy of one hour's summary, if summarised.
func (t *TrendHours) Hour(h time.Time) (HourSummary, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.hours[h.UTC()]
	if !ok {
		return HourSummary{}, false
	}
	return *s, true
}

// TrendBucket is one day, week or month of summaries.
type TrendBucket struct {
	Start                                          time.Time // in the requested zone
	Nodes, Gateways, NewNodes, Packets, Receptions int
	ByType                                         map[string]int
}

// bucketStart truncates t, in loc, to the start of its day, ISO week
// (Monday) or month.
func bucketStart(t time.Time, unit string, loc *time.Location) time.Time {
	l := t.In(loc)
	d := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
	switch unit {
	case "week":
		wd := (int(d.Weekday()) + 6) % 7 // Monday = 0
		return d.AddDate(0, 0, -wd)
	case "month":
		return time.Date(l.Year(), l.Month(), 1, 0, 0, 0, 0, loc)
	}
	return d
}

// Buckets sums the summaries into days, weeks or months starting in loc.
// Distinct nodes and gateways are unions of the hours' sets; new nodes are
// those whose first summarised hour falls in the bucket; a packet heard
// either side of an hour boundary counts in both (rare). With a region
// (one of Regions), only the rows uplinked under a topic root naming it
// count, and packets are not split by type (D-194).
func (t *TrendHours) Buckets(unit string, loc *time.Location, region string) []TrendBucket {
	t.mu.Lock()
	defer t.mu.Unlock()
	hours := make([]time.Time, 0, len(t.hours))
	for h := range t.hours {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i].Before(hours[j]) })
	type acc struct {
		b          TrendBucket
		nodes, gws map[int64]struct{}
	}
	var order []time.Time
	by := map[time.Time]*acc{}
	firstSeen := map[int64]time.Time{}
	for _, h := range hours {
		s := t.hours[h]
		if region != "" {
			r := s.Regions[region]
			s = &HourSummary{Nodes: r.Nodes, Gateways: r.Gateways, Packets: r.Packets, Receptions: r.Receptions}
		}
		k := bucketStart(h, unit, loc)
		a, ok := by[k]
		if !ok {
			a = &acc{b: TrendBucket{Start: k, ByType: map[string]int{}}, nodes: map[int64]struct{}{}, gws: map[int64]struct{}{}}
			by[k] = a
			order = append(order, k)
		}
		for _, n := range s.Nodes {
			a.nodes[n] = struct{}{}
			if _, seen := firstSeen[n]; !seen {
				firstSeen[n] = k
			}
		}
		for _, g := range s.Gateways {
			a.gws[g] = struct{}{}
		}
		a.b.Packets += s.Packets
		a.b.Receptions += s.Receptions
		for ty, c := range s.ByType {
			a.b.ByType[ty] += c
		}
	}
	news := map[time.Time]int{}
	for _, k := range firstSeen {
		news[k]++
	}
	out := make([]TrendBucket, 0, len(order))
	for _, k := range order {
		a := by[k]
		a.b.Nodes, a.b.Gateways, a.b.NewNodes = len(a.nodes), len(a.gws), news[k]
		out = append(out, a.b)
	}
	return out
}
