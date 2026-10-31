package query

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/graph"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/window"
)

// MaxEdges bounds edge responses; larger graphs keep the best-supported.
const MaxEdges = 20000

// Edges is the in-window link graph.
type Edges struct {
	Edges       []graph.Edge `json:"edges"`
	Truncated   bool         `json:"truncated"`
	Diagnostics struct {
		RelayAmbiguous int `json:"relay_ambiguous" doc:"relay hints matching several in-window nodes (no edge)"`
		RelayUnmatched int `json:"relay_unmatched" doc:"relay hints matching no in-window node (no edge)"`
	} `json:"diagnostics"`
}

// BuildEdges derives evidence-backed links from rows inside the window.
// known lists node numbers observed or referenced in the same window and pos
// their reported in-window positions; relay hints are resolved only against
// them (graph.ResolveRelay).
func BuildEdges(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, known []uint32, pos map[uint32]graph.LatLon) (*Edges, error) {
	var samples []graph.Sample
	out := &Edges{}

	// A. NeighborInfo: neighbour -> reporter, float SNR. One per logical packet.
	b := where(w).filters(f).and("packet_type = 'neighborinfo'")
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (logical_packet_key) source_node_id, observed_at, logical_packet_key, decoded_metadata->'neighborinfo'->'neighbors'
		FROM packet_log WHERE `+b.String()+` ORDER BY logical_packet_key, observed_at`, b.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var src int64
		var at time.Time
		var lp, raw []byte
		if err := rows.Scan(&src, &at, &lp, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		var nbs []struct {
			ID  uint32   `json:"id"`
			SNR *float64 `json:"snr"`
		}
		_ = json.Unmarshal(raw, &nbs)
		for _, nb := range nbs {
			samples = append(samples, graph.Sample{Src: nb.ID, Dst: uint32(src), Ev: graph.Neighbor, T: at, SNR: nb.SNR, Key: hex.EncodeToString(lp)})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// B. Traceroute: adjacent segments of every valid copy (deduplicated by
	// logical packet + segment in the reducer).
	b = where(w).filters(f).and("packet_type = 'traceroute'").and("(decoded_metadata->'traceroute'->>'valid')::boolean")
	rows, err = pool.Query(ctx, `
		SELECT source_node_id, COALESCE(destination_node_id, 0), observed_at, logical_packet_key, decoded_metadata->'traceroute'
		FROM packet_log WHERE `+b.String()+` ORDER BY observed_at, id`, b.args...) // earliest copy first: deterministic sample times
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var src, dst int64
		var at time.Time
		var lp, raw []byte
		if err := rows.Scan(&src, &dst, &at, &lp, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		var tr struct {
			Route      []graph.Hop `json:"route"`
			SNRTowards []*float64  `json:"snr_towards"`
			RouteBack  []graph.Hop `json:"route_back"`
			SNRBack    []*float64  `json:"snr_back"`
			IsReply    bool        `json:"is_reply"`
		}
		if json.Unmarshal(raw, &tr) != nil {
			continue
		}
		samples = append(samples, graph.TracerouteSamples(graph.TracerouteRecord{
			From: uint32(src), To: uint32(dst), IsReply: tr.IsReply, Route: tr.Route, SNRTowards: tr.SNRTowards,
			RouteBack: tr.RouteBack, SNRBack: tr.SNRBack, T: at, Logical: hex.EncodeToString(lp)})...)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// C/D. Gateway receptions: proven zero-hop RF -> source->gateway;
	// relayed RF with a unique last-byte match -> relay->gateway (low).
	b = where(w).filters(f).and("gateway_node_id IS NOT NULL").
		and("((decoded_metadata->'rx'->>'direct_rf')::boolean OR (decoded_metadata->'rx'->>'reason' = 'relayed' AND relay_hint IS NOT NULL))").
		and("(rx_snr IS NOT NULL OR rx_rssi IS NOT NULL)")
	rows, err = pool.Query(ctx, `
		SELECT DISTINCT ON (observation_key) source_node_id, gateway_node_id, observed_at, rx_snr, rx_rssi,
		       (decoded_metadata->'rx'->>'direct_rf')::boolean, COALESCE(relay_hint, 0), observation_key
		FROM packet_log WHERE `+b.String()+` ORDER BY observation_key, id`, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Relayed receptions are resolved after all confirmed evidence is in, so
	// the candidate filter can use it.
	type relayed struct {
		s          graph.Sample
		hint       uint8
		origin, gw uint32
	}
	var pending []relayed
	for rows.Next() {
		var src, gw int64
		var at time.Time
		var snr *float32
		var rssi *int32
		var direct bool
		var relay int32
		var ok []byte
		if err := rows.Scan(&src, &gw, &at, &snr, &rssi, &direct, &relay, &ok); err != nil {
			return nil, err
		}
		s := graph.Sample{Dst: uint32(gw), T: at, SNR: f32(snr), RSSI: i32(rssi), Key: hex.EncodeToString(ok)}
		if direct {
			s.Src, s.Ev = uint32(src), graph.DirectRF
			samples = append(samples, s)
		} else {
			pending = append(pending, relayed{s, uint8(relay), uint32(src), uint32(gw)})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rc := graph.NewRelayContext(known, pos, samples)
	for _, r := range pending {
		cand, res := graph.ResolveRelay(r.hint, r.origin, r.gw, rc)
		switch res {
		case graph.RelayResolved:
			r.s.Src, r.s.Ev = cand, graph.RelayHint
			samples = append(samples, r.s)
		case graph.RelayAmbiguous:
			out.Diagnostics.RelayAmbiguous++
		default:
			out.Diagnostics.RelayUnmatched++
		}
	}

	out.Edges = graph.Reduce(samples, protocol.NodeID)
	if len(out.Edges) > MaxEdges {
		out.Edges, out.Truncated = out.Edges[:MaxEdges], true
	}
	return out, nil
}
