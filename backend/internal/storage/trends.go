package storage

import (
	"context"
	"slices"
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
	// Per node of Nodes, in the same order (D-195): its distinct packets
	// and their receptions by other gateways that hour (its own uplinks of
	// them left out, as in Details; each at most MaxNodeHourCount), and the
	// lowest battery level its device telemetry reported (NoBattery when
	// none; BatteryPowered when it reported only external power). Parallel
	// arrays rather than a map: 5 bytes per node and hour, about 9 MB for
	// 400 nodes heard an hour over six months (the ids in Nodes take 14).
	NodePackets, NodeReceptions []uint16
	NodeBattery                 []int8
	// Per node of Nodes, for what the nodes run (D-198): NodeRadio holds
	// whether its packets (map reports aside) carried a hop start (the low
	// two bits: HopNone, HopWithout or HopWith) and, above them, 1 + the
	// index in PresetNames of the preset whose default channel name it was
	// heard on most that hour (0: none). NodeFacts indexes the TrendHours'
	// table of what nodes said about themselves (its newest trusted
	// NodeInfo, named map report, stated firmware version and proven preset
	// that hour; 0: nothing). 3 bytes per node and hour.
	NodeRadio []uint8
	NodeFacts []uint16
}

const (
	// MaxNodeHourCount caps a node's packets and receptions in one hour, so
	// they fit in 16 bits: 18 a second, far beyond any real node.
	MaxNodeHourCount = 65535
	// NoBattery marks an hour without a battery level from the node.
	NoBattery = -1
	// BatteryPowered is the level firmware reports on external power, as
	// stored (ports.Telemetry keeps levels up to 101) and as the engine reads it.
	BatteryPowered = 101
)

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
//
// One refresh runs at a time (refreshing); the summaries themselves are
// only locked (mu) while read or while a refreshed range replaces its
// hours, so sums can be taken while a refresh reads the log: they are then
// the previous refresh's, some hours already newer.
type TrendHours struct {
	refreshing sync.Mutex
	// The highest packet_log id at the last refresh and at the one before:
	// ids come from a sequence, so rows stored since then, in whatever hour
	// (imported history), have higher ids (D-151). Under refreshing.
	seenID, olderID int64

	mu       sync.Mutex
	hours    map[time.Time]*HourSummary
	facts    factTable  // what NodeFacts index (D-198)
	oldest   *time.Time // the oldest retained row at the last refresh
	last     time.Time  // wall clock of the last complete refresh counted fresh
	complete bool       // some refresh (or warm-up) has completed
}

// Rows that failed verification never count (D-093); rows stored as "other"
// before node status and store-and-forward were decoded count as those (D-103).
// Per-node figures (pn) come from the same rows (r, read once), ordered by
// node id like the hour's node set (D-195), as is each node's radio evidence
// (radio: hop start and the preset of its most heard default channel name,
// cp, from $4 and $5, the channel names lower case and their presets, as
// 1 + an index into $6, PresetNames); what nodes said about themselves (nf:
// newest trusted NodeInfo, named map report, stated version and proven
// preset) comes per hour only for the nodes that said anything (D-198).
var trendRangeSQL = `
	WITH r AS (
	  SELECT date_trunc('hour', observed_at) AS h, source_node_id AS s, gateway_node_id AS g, logical_packet_key AS l, decode_version AS dv,
	    substring(mqtt_topic from '/(Nord-Norge|Trøndelag|Vestlandet|Østlandet|Sørlandet)(?:/|$)') AS reg,
	    CASE WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'STORE_FORWARD_APP' THEN 'store_forward'
	         WHEN packet_type = 'other' AND decoded_metadata->'other'->>'port_name' = 'NODE_STATUS_APP' THEN 'node_status'
	         ELSE packet_type END AS ty,
	    CASE WHEN packet_type = 'telemetry' AND decoded_metadata->'telemetry'->>'kind' = 'device' THEN (decoded_metadata->'telemetry'->>'battery')::float8 END AS bat,
	    hop_start IS NOT NULL AS hs, lower(channel_name) AS ch,
	    CASE WHEN packet_type IN ('nodeinfo', 'mapreport') THEN decoded_metadata END AS meta, observed_at AS at, id
	  FROM packet_log WHERE ` + window.Predicate(1, 2) + ` AND packet_type <> 'invalid'),
	agg AS (SELECT h, array_agg(DISTINCT s ORDER BY s) AS nodes, array_remove(array_agg(DISTINCT g ORDER BY g), NULL) AS gws, count(DISTINCT l) AS p, count(*) AS rc, bool_or(dv < $3) AS stale FROM r GROUP BY h),
	types AS (SELECT h, jsonb_object_agg(ty, c) AS j FROM (SELECT h, ty, count(DISTINCT l) AS c FROM r GROUP BY h, ty) x GROUP BY h),
	regs AS (SELECT h, jsonb_object_agg(reg, jsonb_build_object('n', nodes, 'g', gws, 'p', p, 'r', rc)) AS j FROM (
	  SELECT h, reg, array_agg(DISTINCT s ORDER BY s) AS nodes, array_remove(array_agg(DISTINCT g ORDER BY g), NULL) AS gws, count(DISTINCT l) AS p, count(*) AS rc
	  FROM r WHERE reg IS NOT NULL GROUP BY h, reg) x GROUP BY h),
	cp AS (SELECT DISTINCT ON (h, s) h, s, pre FROM (
	  SELECT h, s, d.pre, count(*) AS c FROM r JOIN unnest($4::text[], $5::text[]) AS d(name, pre) ON r.ch = d.name WHERE r.ty <> 'mapreport' GROUP BY h, s, d.pre) x
	  ORDER BY h, s, c DESC, pre),
	pn AS (SELECT h, array_agg(p ORDER BY s) AS p, array_agg(rc ORDER BY s) AS rc, array_agg(COALESCE(bat, -1) ORDER BY s) AS bat,
	    array_agg(hop + 4 * COALESCE(array_position($6::text[], cp.pre), 0) ORDER BY s) AS radio FROM (
	  SELECT h, s, LEAST(count(DISTINCT l), 65535)::int AS p, LEAST(count(*) FILTER (WHERE g IS DISTINCT FROM s), 65535)::int AS rc, round(min(bat))::int AS bat,
	    CASE bool_or(hs) FILTER (WHERE ty <> 'mapreport') WHEN true THEN 2 WHEN false THEN 1 ELSE 0 END AS hop FROM r GROUP BY h, s) x LEFT JOIN cp USING (h, s) GROUP BY h),
	nf AS (SELECT h, s,
	    (array_agg(meta->'nodeinfo' ORDER BY at DESC, id DESC) FILTER (WHERE ty = 'nodeinfo' AND meta ? 'nodeinfo'
	      AND NOT COALESCE((meta->'nodeinfo'->>'identity_untrusted')::boolean, false)))[1] AS ni,
	    (array_agg(meta->'mapreport' ORDER BY at DESC, id DESC) FILTER (WHERE ty = 'mapreport'
	      AND (COALESCE(meta->'mapreport'->>'long_name', '') <> '' OR COALESCE(meta->'mapreport'->>'short_name', '') <> '')))[1] AS mr,
	    (array_agg(meta->'mapreport'->>'firmware_version' ORDER BY at DESC, id DESC) FILTER (WHERE ty = 'mapreport'
	      AND meta->'mapreport'->>'firmware_version' ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([^0-9]|$)'))[1] AS fw,
	    (array_agg(meta->'mapreport'->>'modem_preset' ORDER BY at DESC, id DESC) FILTER (WHERE ty = 'mapreport'
	      AND (meta->'mapreport'->>'has_default_channel')::boolean AND COALESCE(meta->'mapreport'->>'modem_preset', '') <> ''))[1] AS pre
	  FROM r WHERE meta IS NOT NULL GROUP BY h, s),
	facts AS (SELECT h, jsonb_agg(jsonb_build_object('s', s, 'ni', ni, 'mr', mr, 'fw', fw, 'p', pre) ORDER BY s) AS j FROM nf
	  WHERE ni IS NOT NULL OR mr IS NOT NULL OR fw IS NOT NULL OR pre IS NOT NULL GROUP BY h)
	SELECT agg.h, agg.nodes, agg.gws, agg.p, agg.rc, COALESCE(types.j, '{}'::jsonb), agg.stale, COALESCE(regs.j, '{}'::jsonb), pn.p, pn.rc, pn.bat, pn.radio,
	  COALESCE(facts.j, '[]'::jsonb)
	FROM agg JOIN pn USING (h) LEFT JOIN types USING (h) LEFT JOIN regs USING (h) LEFT JOIN facts USING (h)`

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
	t.refreshing.Lock()
	defer t.refreshing.Unlock()
	return t.refresh(ctx, pool, now)
}

// refresh is Refresh with t.refreshing held; t.mu is taken only to look at
// and replace the summaries, never across a query.
func (t *TrendHours) refresh(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	var oldest, newest *time.Time
	var maxID *int64
	if err := pool.QueryRow(ctx, `SELECT min(observed_at), max(observed_at), max(id) FROM packet_log`).Scan(&oldest, &newest, &maxID); err != nil {
		return err
	}
	t.mu.Lock()
	if t.hours == nil {
		t.hours = map[time.Time]*HourSummary{}
	}
	t.oldest = oldest
	if oldest == nil {
		t.hours = map[time.Time]*HourSummary{}
		t.last, t.complete = time.Now(), true
		t.mu.Unlock()
		t.seenID, t.olderID = 0, 0
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
	t.mu.Unlock()
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
	t.mu.Lock()
	t.last, t.complete = time.Now(), true
	t.mu.Unlock()
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
	rows, err := pool.Query(ctx, trendRangeSQL, lo, hi, ingest.DecodeVersion, presetChannels, presetChannelPresets, PresetNames)
	if err != nil {
		return err
	}
	defer rows.Close()
	fresh := map[time.Time]*HourSummary{}
	said := map[time.Time][]saidFacts{}
	for rows.Next() {
		var h time.Time
		s := &HourSummary{DecodeVersion: ingest.DecodeVersion}
		var stale bool
		var pk, rc, bat, radio []int32
		var facts []factRow
		if err := rows.Scan(&h, &s.Nodes, &s.Gateways, &s.Packets, &s.Receptions, &s.ByType, &stale, &s.Regions, &pk, &rc, &bat, &radio, &facts); err != nil {
			return err
		}
		s.setNodeFigures(pk, rc, bat)
		s.setNodeRadio(radio)
		said[h.UTC()] = s.alignFacts(facts)
		if stale {
			// Some rows are still to be decoded again: read this hour again later.
			s.DecodeVersion = 0
		}
		fresh[h.UTC()] = s
	}
	if err := rows.Err(); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for h := lo; h.Before(hi); h = h.Add(time.Hour) {
		delete(t.hours, h)
	}
	for h, s := range fresh {
		t.setFacts(s, said[h])
		t.hours[h] = s
	}
	return nil
}

// setNodeFigures keeps the per-node figures compactly, if they align with
// Nodes (both are ordered by node id, so they always should).
func (s *HourSummary) setNodeFigures(pk, rc, bat []int32) {
	if len(pk) != len(s.Nodes) || len(rc) != len(s.Nodes) || len(bat) != len(s.Nodes) {
		return
	}
	s.NodePackets, s.NodeReceptions, s.NodeBattery = make([]uint16, len(pk)), make([]uint16, len(rc)), make([]int8, len(bat))
	for i := range pk {
		s.NodePackets[i] = uint16(min(max(pk[i], 0), MaxNodeHourCount))
		s.NodeReceptions[i] = uint16(min(max(rc[i], 0), MaxNodeHourCount))
		s.NodeBattery[i] = int8(min(max(bat[i], NoBattery), BatteryPowered))
	}
}

// Fresh reports whether the summaries were refreshed within every.
func (t *TrendHours) Fresh(every time.Duration) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.hours != nil && !t.last.IsZero() && time.Since(t.last) < every
}

// Complete reports whether some refresh has completed: the sums cover the
// whole retained log as of then, if not what arrived since.
func (t *TrendHours) Complete() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.complete
}

// RefreshEvery refreshes at most once per every (wall clock): requests in
// between, whatever bucket or zone they ask for, reuse the summaries. The
// look comes after waiting for any refresh already running, so callers
// arriving meanwhile find the summaries fresh once it ends, instead of each
// reading the log again in turn; if it failed, the next one carries it on.
func (t *TrendHours) RefreshEvery(ctx context.Context, pool *pgxpool.Pool, now time.Time, every time.Duration) error {
	t.refreshing.Lock()
	defer t.refreshing.Unlock()
	if t.Fresh(every) {
		return nil
	}
	return t.refresh(ctx, pool, now)
}

// Warm reads the summaries without counting them fresh: the first request
// still looks again, but only at what arrived since (an empty log at start
// must not answer for the next every).
func (t *TrendHours) Warm(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	t.refreshing.Lock()
	defer t.refreshing.Unlock()
	err := t.refresh(ctx, pool, now)
	t.mu.Lock()
	t.last = time.Time{}
	t.mu.Unlock()
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

// NodeBucket is one day, week or month of one node's hours (D-195).
type NodeBucket struct {
	Start        time.Time // in the requested zone
	Hours        int       // summarised hours: any row was logged in them
	HoursHeard   int       // hours it sent anything in
	HoursGateway int       // hours it uplinked anything as a gateway
	Packets      int       // its distinct packets, summed per hour
	Receptions   int       // gateway receptions of them
	Battery      int       // lowest level reported, NoBattery or BatteryPowered
}

// NodeBuckets sums one node's hours into days, weeks or months starting in
// loc, from the bucket it was first heard in (as a sender or a gateway) up
// to the newest summarised hour, so buckets it was silent in count zero; ok
// is false when no summarised hour holds it. A bucket's hours are those in
// which anything at all was logged, so hours the collector heard nothing
// are not counted against the node.
func (t *TrendHours) NodeBuckets(node int64, unit string, loc *time.Location) (out []NodeBucket, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hours := make([]time.Time, 0, len(t.hours))
	for h := range t.hours {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i].Before(hours[j]) })
	var from time.Time
	for _, h := range hours {
		s := t.hours[h]
		if _, in := slices.BinarySearch(s.Nodes, node); in {
			from = bucketStart(h, unit, loc)
			break
		}
		if _, in := slices.BinarySearch(s.Gateways, node); in {
			from = bucketStart(h, unit, loc)
			break
		}
	}
	if from.IsZero() {
		return nil, false
	}
	for _, h := range hours {
		k := bucketStart(h, unit, loc)
		if k.Before(from) {
			continue
		}
		if len(out) == 0 || !out[len(out)-1].Start.Equal(k) {
			out = append(out, NodeBucket{Start: k, Battery: NoBattery})
		}
		b := &out[len(out)-1]
		s := t.hours[h]
		b.Hours++
		if _, in := slices.BinarySearch(s.Gateways, node); in {
			b.HoursGateway++
		}
		i, in := slices.BinarySearch(s.Nodes, node)
		if !in {
			continue
		}
		b.HoursHeard++
		if len(s.NodePackets) != len(s.Nodes) {
			continue
		}
		b.Packets += int(s.NodePackets[i])
		b.Receptions += int(s.NodeReceptions[i])
		b.Battery = lowerBattery(b.Battery, int(s.NodeBattery[i]))
	}
	return out, true
}

// lowerBattery is the lower of two levels, any level below external power
// counting lower than it and either lower than none.
func lowerBattery(a, b int) int {
	switch {
	case b == NoBattery:
		return a
	case a == NoBattery:
		return b
	}
	return min(a, b)
}
