package query

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/graph"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/window"
)

// GeoOptions configure location estimates for unpositioned nodes.
type GeoOptions struct {
	Enabled          bool
	MinPrecisionBits uint32
	Exclude          map[uint32]bool
	Params           geo.Params
}

// MaxNodes bounds a snapshot; larger meshes are truncated by activity.
const MaxNodes = 5000

// Identity is the latest applicable in-window NodeInfo for a node.
type Identity struct {
	LongName     string    `json:"long_name,omitempty"`
	ShortName    string    `json:"short_name,omitempty"`
	HwModel      string    `json:"hw_model,omitempty"`
	Role         string    `json:"role,omitempty"`
	HasPublicKey bool      `json:"has_public_key"`
	Signature    string    `json:"signature" enum:"verified,unsigned,unverifiable,not-applicable"`
	ObservedAt   time.Time `json:"observed_at"`
}

// Position is the latest in-window reported position.
type Position struct {
	Lat            float64   `json:"lat"`
	Lon            float64   `json:"lon"`
	Alt            *int32    `json:"alt,omitempty"`
	PrecisionBits  uint32    `json:"precision_bits"`
	PrecisionKnown bool      `json:"precision_known"`
	Signature      string    `json:"signature" enum:"verified,unsigned,unverifiable,not-applicable"`
	ObservedAt     time.Time `json:"observed_at"`
	Source         string    `json:"source" enum:"position,mapreport" doc:"Packet type the position came from"`

	id int64 // row id, tie-break for equal observed_at
}

// Telemetry is the latest in-window device telemetry.
type Telemetry struct {
	Battery    *float64  `json:"battery,omitempty"`
	Voltage    *float64  `json:"voltage,omitempty"`
	ChUtil     *float64  `json:"ch_util,omitempty"`
	AirUtil    *float64  `json:"air_util,omitempty"`
	Uptime     *uint32   `json:"uptime,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

// SignatureCounts counts unique packets by verification status.
type SignatureCounts struct {
	Verified      int `json:"verified"`
	Unsigned      int `json:"unsigned"`
	Unverifiable  int `json:"unverifiable"`
	NotApplicable int `json:"not_applicable"`
}

// Node is everything known about one node inside the window. Nil fields
// mean "not reported in the selected period" — never filled from outside.
type Node struct {
	ID     string `json:"id" example:"!a1b2c3d4"`
	Num    uint32 `json:"num"`
	Status string `json:"status" enum:"observed,referenced" doc:"observed: sent or uplinked packets in the window; referenced: only mentioned by others' NeighborInfo/traceroutes"`

	Identity  *Identity  `json:"identity,omitempty"`
	Position  *Position  `json:"position,omitempty"`
	Telemetry *Telemetry `json:"telemetry,omitempty"`

	FirstSeen         *time.Time      `json:"first_seen,omitempty"`
	LastSeen          *time.Time      `json:"last_seen,omitempty"`
	Packets           int             `json:"packets" doc:"unique packets originated in window"`
	Receptions        int             `json:"receptions" doc:"gateway receptions of those packets"`
	GatewayReceptions int             `json:"gateway_receptions" doc:"receptions this node uplinked as an MQTT gateway"`
	IsGateway         bool            `json:"is_gateway"`
	Signatures        SignatureCounts `json:"signatures"`
	Brokers           []string        `json:"brokers,omitempty"`

	MQTTOptOut bool `json:"mqtt_opt_out,omitempty" doc:"The node sent packets in the window without the OK-to-MQTT flag that reached us through another gateway; its NodeInfo is not stored, so it stays unnamed"`

	Estimate     *geo.Estimate `json:"estimate,omitempty" doc:"Approximate location from in-window RF links; never a reported position"`
	EstimateNote string        `json:"estimate_note,omitempty" doc:"Why no estimate was produced for an unpositioned node"`
}

// Counts summarises the window.
type Counts struct {
	Packets      int            `json:"packets" doc:"unique logical packets"`
	Receptions   int            `json:"receptions" doc:"distinct gateway receptions"`
	Nodes        int            `json:"nodes"`
	Referenced   int            `json:"referenced"`
	Positioned   int            `json:"positioned"`
	Estimated    int            `json:"estimated"`
	Edges        int            `json:"edges"`
	ByType       map[string]int `json:"by_type" doc:"unique packets per packet type"`
	FirstEvent   *time.Time     `json:"first_event,omitempty"`
	LastEvent    *time.Time     `json:"last_event,omitempty"`
	NodesTrimmed bool           `json:"nodes_truncated"`
}

// Snapshot is the time-isolated state of the mesh for one window.
type Snapshot struct {
	Nodes          []Node       `json:"nodes"`
	Edges          []graph.Edge `json:"edges"`
	EdgesTruncated bool         `json:"edges_truncated"`
	Counts         Counts       `json:"counts"`
	Diagnostics    struct {
		RelayAmbiguous int `json:"relay_ambiguous"`
		RelayUnmatched int `json:"relay_unmatched"`
	} `json:"diagnostics"`
}

func t(ts time.Time) *time.Time { return &ts }

// BuildSnapshot computes nodes and counts from rows inside the window only.
func BuildSnapshot(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, g GeoOptions) (*Snapshot, error) {
	nodes := map[uint32]*Node{}
	get := func(n uint32) *Node {
		if x, ok := nodes[n]; ok {
			return x
		}
		x := &Node{ID: protocol.NodeID(n), Num: n, Status: "observed"}
		nodes[n] = x
		return x
	}

	// Originated traffic.
	b := where(w).filters(f)
	rows, err := pool.Query(ctx, `
		SELECT source_node_id, min(observed_at), max(observed_at),
		       count(DISTINCT logical_packet_key), count(DISTINCT observation_key),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'verified'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'unsigned'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'unverifiable'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'not-applicable'),
		       array_agg(DISTINCT broker_id),
		       COALESCE(bool_or((decoded_metadata->>'not_ok_to_mqtt')::boolean), false)
		FROM packet_log WHERE `+b.String()+` GROUP BY 1`, b.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n int64
		var first, last time.Time
		var x Node
		if err := rows.Scan(&n, &first, &last, &x.Packets, &x.Receptions, &x.Signatures.Verified, &x.Signatures.Unsigned,
			&x.Signatures.Unverifiable, &x.Signatures.NotApplicable, &x.Brokers, &x.MQTTOptOut); err != nil {
			rows.Close()
			return nil, err
		}
		node := get(uint32(n))
		node.FirstSeen, node.LastSeen = t(first), t(last)
		node.Packets, node.Receptions, node.Signatures, node.Brokers, node.MQTTOptOut = x.Packets, x.Receptions, x.Signatures, x.Brokers, x.MQTTOptOut
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Gateway activity (the gateway id is an unauthenticated MQTT claim, but
	// it is still an in-window observation of that node acting as gateway).
	b = where(w).filters(f).and("gateway_node_id IS NOT NULL")
	rows, err = pool.Query(ctx, `
		SELECT gateway_node_id, min(observed_at), max(observed_at), count(DISTINCT observation_key)
		FROM packet_log WHERE `+b.String()+` GROUP BY 1`, b.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n int64
		var first, last time.Time
		var c int
		if err := rows.Scan(&n, &first, &last, &c); err != nil {
			rows.Close()
			return nil, err
		}
		node := get(uint32(n))
		node.IsGateway, node.GatewayReceptions = true, c
		if node.FirstSeen == nil || first.Before(*node.FirstSeen) {
			node.FirstSeen = t(first)
		}
		if node.LastSeen == nil || last.After(*node.LastSeen) {
			node.LastSeen = t(last)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := latestIdentities(ctx, pool, w, f, nil, func(n uint32, id Identity) { get(n).Identity = &id }); err != nil {
		return nil, err
	}
	if err := latestPositions(ctx, pool, w, f, nil, func(n uint32, p Position) { get(n).Position = &p }); err != nil {
		return nil, err
	}
	if err := latestTelemetry(ctx, pool, w, f, nil, func(n uint32, tm Telemetry) { get(n).Telemetry = &tm }); err != nil {
		return nil, err
	}
	refs, err := referencedNodes(ctx, pool, w, f)
	if err != nil {
		return nil, err
	}
	for _, n := range refs {
		if _, ok := nodes[n]; !ok {
			nodes[n] = &Node{ID: protocol.NodeID(n), Num: n, Status: "referenced"}
		}
	}

	counts, err := windowCounts(ctx, pool, w, f)
	if err != nil {
		return nil, err
	}
	known := make([]uint32, 0, len(nodes))
	for n := range nodes {
		known = append(known, n)
	}
	pos := map[uint32]graph.LatLon{}
	for n, nd := range nodes {
		if nd.Position != nil {
			pos[n] = graph.LatLon{Lat: nd.Position.Lat, Lon: nd.Position.Lon}
		}
	}
	edges, err := BuildEdges(ctx, pool, w, f, known, pos)
	if err != nil {
		return nil, err
	}
	if g.Enabled {
		estimate(nodes, edges.Edges, g)
	}
	out := &Snapshot{Nodes: make([]Node, 0, len(nodes)), Counts: *counts, Edges: edges.Edges, EdgesTruncated: edges.Truncated}
	out.Diagnostics.RelayAmbiguous, out.Diagnostics.RelayUnmatched = edges.Diagnostics.RelayAmbiguous, edges.Diagnostics.RelayUnmatched
	out.Counts.Edges = len(edges.Edges)
	for _, n := range nodes {
		out.Nodes = append(out.Nodes, *n)
		if n.Status == "observed" {
			out.Counts.Nodes++
		} else {
			out.Counts.Referenced++
		}
		if n.Position != nil {
			out.Counts.Positioned++
		}
		if n.Estimate != nil {
			out.Counts.Estimated++
		}
	}
	sort.Slice(out.Nodes, func(i, j int) bool {
		a, b := out.Nodes[i], out.Nodes[j]
		if a.Packets+a.GatewayReceptions != b.Packets+b.GatewayReceptions {
			return a.Packets+a.GatewayReceptions > b.Packets+b.GatewayReceptions
		}
		return a.Num < b.Num
	})
	if len(out.Nodes) > MaxNodes {
		out.Nodes = out.Nodes[:MaxNodes]
		out.Counts.NodesTrimmed = true
	}
	return out, nil
}

// estimate fills Estimate for unpositioned nodes from in-window direct
// links to precisely positioned anchors. Anchors and links come only from
// this window (and replay prefix); relay-hint-only links are excluded.
func estimate(nodes map[uint32]*Node, edges []graph.Edge, g GeoOptions) {
	anchors := map[uint32]geo.Anchor{}
	for n, x := range nodes {
		if x.Position != nil && x.Position.PrecisionKnown && x.Position.PrecisionBits >= g.MinPrecisionBits && !g.Exclude[n] {
			anchors[n] = geo.Anchor{Node: n, Lat: x.Position.Lat, Lon: x.Position.Lon, ErrM: geo.PrecisionErrorM(x.Position.PrecisionBits, x.Position.Lat)}
		}
	}
	type agg struct {
		snrSum, snrW float64
		rssiSum      float64
		rssiW        float64
		samples      int
		first, last  time.Time
	}
	links := map[uint32]map[uint32]*agg{} // target -> anchor
	add := func(target, anchor uint32, e graph.Edge) {
		direct := e.Evidence.Neighbor + e.Evidence.Traceroute + e.Evidence.DirectRF
		if direct == 0 {
			return
		}
		if links[target] == nil {
			links[target] = map[uint32]*agg{}
		}
		a := links[target][anchor]
		if a == nil {
			a = &agg{first: e.FirstAt, last: e.LastAt}
			links[target][anchor] = a
		}
		a.samples += direct
		if e.SNR.Median != nil {
			a.snrSum += *e.SNR.Median * float64(e.SNR.N)
			a.snrW += float64(e.SNR.N)
		}
		if e.RSSI.Median != nil {
			a.rssiSum += *e.RSSI.Median * float64(e.RSSI.N)
			a.rssiW += float64(e.RSSI.N)
		}
		if e.FirstAt.Before(a.first) {
			a.first = e.FirstAt
		}
		if e.LastAt.After(a.last) {
			a.last = e.LastAt
		}
	}
	for _, e := range edges {
		if _, ok := anchors[e.SrcNum]; ok {
			add(e.DstNum, e.SrcNum, e)
		}
		if _, ok := anchors[e.DstNum]; ok {
			add(e.SrcNum, e.DstNum, e)
		}
	}
	for n, x := range nodes {
		if x.Position != nil || g.Exclude[n] {
			continue
		}
		var ms []geo.Measurement
		for anchor, a := range links[n] {
			m := geo.Measurement{Anchor: anchor, Samples: a.samples, First: a.first, Last: a.last}
			if a.snrW > 0 {
				v := a.snrSum / a.snrW
				m.SNR = &v
			}
			if a.rssiW > 0 {
				v := a.rssiSum / a.rssiW
				m.RSSI = &v
			}
			ms = append(ms, m)
		}
		sort.Slice(ms, func(i, j int) bool { return ms[i].Anchor < ms[j].Anchor }) // deterministic notes
		if len(ms) == 0 {
			x.EstimateNote = fmt.Sprintf("no confirmed direct links to nodes reporting a position with at least %d-bit precision", g.MinPrecisionBits)
			continue
		}
		est, err := geo.Locate(anchors, ms, g.Params, protocol.NodeID)
		if err != nil {
			x.EstimateNote = err.Error()
			continue
		}
		x.Estimate = est
	}
}

func nodeFilter(b *sqlb, node *uint32) *sqlb {
	if node != nil {
		b.and("source_node_id = ?", int64(*node))
	}
	return b
}

// latestIdentities: the latest applicable in-window NodeInfo per node.
// Unsigned NodeInfo from a node with an authoritative key is not applicable
// (it may be a spoof) and is skipped.
func latestIdentities(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, node *uint32, fn func(uint32, Identity)) error {
	b := nodeFilter(where(w).filters(f).and("packet_type = 'nodeinfo'").
		and("NOT COALESCE((decoded_metadata->'nodeinfo'->>'identity_untrusted')::boolean, false)"), node)
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (source_node_id) source_node_id, observed_at, signature_status, decoded_metadata->'nodeinfo'
		FROM packet_log WHERE `+b.String()+`
		ORDER BY source_node_id, observed_at DESC, id DESC`, b.args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var n int64
		var at time.Time
		var sig string
		var raw []byte
		if err := rows.Scan(&n, &at, &sig, &raw); err != nil {
			return err
		}
		var ni struct {
			LongName  string `json:"long_name"`
			ShortName string `json:"short_name"`
			HwModel   string `json:"hw_model"`
			Role      string `json:"role"`
			PublicKey string `json:"public_key"`
		}
		_ = json.Unmarshal(raw, &ni)
		fn(uint32(n), Identity{LongName: ni.LongName, ShortName: ni.ShortName, HwModel: ni.HwModel, Role: ni.Role,
			HasPublicKey: ni.PublicKey != "", Signature: sig, ObservedAt: at})
	}
	return rows.Err()
}

// positionTypes report a node's own location: POSITION_APP packets and map
// reports (both store it under decoded_metadata.position).
const positionTypes = "packet_type IN ('position', 'mapreport')"

// latestPositions: each node's in-window reported position, chosen by
// choosePosition from its latest Position packet and latest map report.
func latestPositions(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, node *uint32, fn func(uint32, Position)) error {
	b := nodeFilter(where(w).filters(f).and(positionTypes).and("decoded_metadata ? 'position'"), node)
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (source_node_id, packet_type) source_node_id, packet_type, id, observed_at, signature_status, decoded_metadata->'position'
		FROM packet_log WHERE `+b.String()+`
		ORDER BY source_node_id, packet_type, observed_at DESC, id DESC`, b.args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	latest := map[uint32]*Position{}
	var order []uint32
	for rows.Next() {
		var n int64
		var p Position
		var raw []byte
		if err := rows.Scan(&n, &p.Source, &p.id, &p.ObservedAt, &p.Signature, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if cur, ok := latest[uint32(n)]; ok {
			c := choosePosition(*cur, p)
			latest[uint32(n)] = &c
		} else {
			latest[uint32(n)] = &p
			order = append(order, uint32(n))
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, n := range order {
		fn(n, *latest[n])
	}
	return nil
}

// choosePosition picks between a node's latest Position packet and latest
// map report. When their precision circles (worst-case error for the
// reported precision bits) overlap, they agree and the more precise one
// wins; when they do not, the node may have moved and the newer one wins.
// Unknown precision cannot be compared, so the newer one wins too.
func choosePosition(a, b Position) Position {
	newer, older := a, b
	if b.ObservedAt.After(a.ObservedAt) || (b.ObservedAt.Equal(a.ObservedAt) && b.id > a.id) {
		newer, older = b, a
	}
	if !a.PrecisionKnown || !b.PrecisionKnown {
		return newer
	}
	d := graph.DistanceM(graph.LatLon{Lat: a.Lat, Lon: a.Lon}, graph.LatLon{Lat: b.Lat, Lon: b.Lon})
	if d > geo.PrecisionErrorM(a.PrecisionBits, a.Lat)+geo.PrecisionErrorM(b.PrecisionBits, b.Lat) {
		return newer
	}
	if older.PrecisionBits > newer.PrecisionBits {
		return older
	}
	return newer
}

// latestTelemetry: the latest in-window device telemetry per node.
func latestTelemetry(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, node *uint32, fn func(uint32, Telemetry)) error {
	b := nodeFilter(where(w).filters(f).and("packet_type = 'telemetry'").and("decoded_metadata->'telemetry'->>'kind' = 'device'"), node)
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (source_node_id) source_node_id, observed_at, decoded_metadata->'telemetry'
		FROM packet_log WHERE `+b.String()+`
		ORDER BY source_node_id, observed_at DESC, id DESC`, b.args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var n int64
		var tm Telemetry
		var raw []byte
		if err := rows.Scan(&n, &tm.ObservedAt, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &tm); err != nil {
			continue
		}
		fn(uint32(n), tm)
	}
	return rows.Err()
}

// referencedNodes are mentioned by in-window NeighborInfo entries, valid
// traceroute hops (placeholders excluded) or traceroute destinations.
func referencedNodes(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters) ([]uint32, error) {
	b := where(w).filters(f)
	q := `
		SELECT (n->>'id')::bigint FROM packet_log, jsonb_array_elements(decoded_metadata->'neighborinfo'->'neighbors') n
		WHERE ` + b.String() + ` AND packet_type = 'neighborinfo'
		UNION
		SELECT (h->>'id')::bigint FROM packet_log,
		       jsonb_array_elements(COALESCE(decoded_metadata->'traceroute'->'route', '[]') || COALESCE(decoded_metadata->'traceroute'->'route_back', '[]')) h
		WHERE ` + b.String() + ` AND packet_type = 'traceroute'
		  AND (decoded_metadata->'traceroute'->>'valid')::boolean
		  AND NOT COALESCE((h->>'unknown')::boolean, false)
		UNION
		SELECT destination_node_id FROM packet_log
		WHERE ` + b.String() + ` AND packet_type = 'traceroute' AND destination_node_id NOT IN (0, 4294967295)`
	rows, err := pool.Query(ctx, q, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uint32
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 && n < 0xFFFFFFFF {
			out = append(out, uint32(n))
		}
	}
	return out, rows.Err()
}

func windowCounts(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters) (*Counts, error) {
	b := where(w).filters(f)
	c := &Counts{ByType: map[string]int{}}
	var first, last *time.Time
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT logical_packet_key), count(DISTINCT observation_key), min(observed_at), max(observed_at)
		FROM packet_log WHERE `+b.String(), b.args...).Scan(&c.Packets, &c.Receptions, &first, &last); err != nil {
		return nil, err
	}
	c.FirstEvent, c.LastEvent = first, last
	rows, err := pool.Query(ctx, `SELECT packet_type, count(DISTINCT logical_packet_key) FROM packet_log WHERE `+b.String()+` GROUP BY 1`, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		c.ByType[k] = n
	}
	return c, rows.Err()
}

// MaxID is the highest row id inside the window: part of the data revision,
// so any new row in the window invalidates cached results.
func MaxID(ctx context.Context, pool *pgxpool.Pool, w window.Window) (int64, error) {
	b := where(w)
	var id *int64
	if err := pool.QueryRow(ctx, `SELECT max(id) FROM packet_log WHERE `+b.String(), b.args...).Scan(&id); err != nil {
		return 0, err
	}
	if id == nil {
		return 0, nil
	}
	return *id, nil
}
