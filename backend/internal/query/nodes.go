package query

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/graph"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/window"
)

// Detail limits.
const (
	maxSamples   = 500
	maxPackets   = 100
	maxGatewayed = 200
)

// Stats summarises a radio metric over in-window samples (shared with the
// graph package so the API schema has one Stats type).
type Stats = graph.Stats

// Hearing is one gateway's receptions of a node's packets (or, from the
// gateway's side, one source it heard).
type Hearing struct {
	Node       string    `json:"node"`
	Receptions int       `json:"receptions"`
	DirectRF   int       `json:"direct_rf" doc:"receptions proven to be zero-hop RF"`
	SNR        Stats     `json:"snr" doc:"dB, direct-RF receptions only"`
	RSSI       Stats     `json:"rssi" doc:"dBm, direct-RF receptions only"`
	LastAt     time.Time `json:"last_at"`
}

// PositionSample is one reported position in the window.
type PositionSample struct {
	At             time.Time `json:"at"`
	Lat            float64   `json:"lat"`
	Lon            float64   `json:"lon"`
	PrecisionBits  uint32    `json:"precision_bits"`
	PrecisionKnown bool      `json:"precision_known"`
	Signature      string    `json:"signature"`
}

// TelemetrySample is one device-telemetry sample in the window.
type TelemetrySample struct {
	At      time.Time `json:"at"`
	Battery *float64  `json:"battery,omitempty"`
	Voltage *float64  `json:"voltage,omitempty"`
	ChUtil  *float64  `json:"ch_util,omitempty"`
	AirUtil *float64  `json:"air_util,omitempty"`
}

// PacketSummary is one unique packet from the node (no bodies, ever).
type PacketSummary struct {
	At         time.Time `json:"at" doc:"first in-window reception"`
	Type       string    `json:"type"`
	PacketID   uint32    `json:"packet_id"`
	To         string    `json:"to,omitempty"`
	Channel    string    `json:"channel,omitempty"`
	Signature  string    `json:"signature"`
	Crypto     string    `json:"crypto"`
	Receptions int       `json:"receptions"`
	Bytes      int       `json:"bytes"`
}

// NodeDetail is the node panel payload, scoped to the window.
type NodeDetail struct {
	Node
	Positions       []PositionSample  `json:"positions"`
	TelemetrySeries []TelemetrySample `json:"telemetry_series"`
	HeardBy         []Hearing         `json:"heard_by" doc:"gateways that uplinked this node's packets"`
	Heard           []Hearing         `json:"heard" doc:"sources this node uplinked as a gateway"`
	Recent          []PacketSummary   `json:"recent_packets"`
	Truncated       bool              `json:"truncated"`
}

// ErrNoNode means the node has no observation or reference in the window.
var ErrNoNode = errors.New("node not observed or referenced in window")

// BuildNodeDetail assembles one node's in-window details.
func BuildNodeDetail(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, num uint32) (*NodeDetail, error) {
	d := &NodeDetail{Node: Node{ID: protocol.NodeID(num), Num: num, Status: "observed"},
		Positions: []PositionSample{}, TelemetrySeries: []TelemetrySample{}, HeardBy: []Hearing{}, Heard: []Hearing{}, Recent: []PacketSummary{}}
	n := int64(num)

	b := where(w).filters(f).and("(source_node_id = ? OR gateway_node_id = ?)", n, n)
	var first, last *time.Time
	if err := pool.QueryRow(ctx, `SELECT min(observed_at), max(observed_at) FROM packet_log WHERE `+b.String(), b.args...).Scan(&first, &last); err != nil {
		return nil, err
	}
	d.FirstSeen, d.LastSeen = first, last

	b = where(w).filters(f).and("source_node_id = ?", n)
	if err := pool.QueryRow(ctx, `
		SELECT count(DISTINCT logical_packet_key), count(DISTINCT observation_key),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'verified'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'unsigned'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'unverifiable'),
		       count(DISTINCT logical_packet_key) FILTER (WHERE signature_status = 'not-applicable'),
		       COALESCE(array_agg(DISTINCT broker_id) FILTER (WHERE broker_id IS NOT NULL), '{}'),
		       COALESCE(bool_or((decoded_metadata->>'not_ok_to_mqtt')::boolean), false)
		FROM packet_log WHERE `+b.String(), b.args...).Scan(&d.Node.Packets, &d.Receptions, &d.Signatures.Verified, &d.Signatures.Unsigned,
		&d.Signatures.Unverifiable, &d.Signatures.NotApplicable, &d.Brokers, &d.MQTTOptOut); err != nil {
		return nil, err
	}

	b = where(w).filters(f).and("gateway_node_id = ?", n)
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT observation_key) FROM packet_log WHERE `+b.String(), b.args...).Scan(&d.GatewayReceptions); err != nil {
		return nil, err
	}
	d.IsGateway = d.GatewayReceptions > 0

	if err := latestIdentities(ctx, pool, w, f, &num, func(_ uint32, id Identity) { d.Identity = &id }); err != nil {
		return nil, err
	}
	if err := latestPositions(ctx, pool, w, f, &num, func(_ uint32, p Position) { d.Position = &p }); err != nil {
		return nil, err
	}
	if err := latestTelemetry(ctx, pool, w, f, &num, func(_ uint32, tm Telemetry) { d.Telemetry = &tm }); err != nil {
		return nil, err
	}

	if d.FirstSeen == nil {
		refs, err := referencedNodes(ctx, pool, w, f)
		if err != nil {
			return nil, err
		}
		found := false
		for _, r := range refs {
			if r == num {
				found = true
			}
		}
		if !found {
			return nil, ErrNoNode
		}
		d.Status = "referenced"
		return d, nil
	}

	// Position history (one sample per logical packet).
	b = where(w).filters(f).and("source_node_id = ?", n).and(positionTypes).and("decoded_metadata ? 'position'")
	lim := b.arg(maxSamples + 1)
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (logical_packet_key) observed_at, signature_status, decoded_metadata->'position'
		FROM packet_log WHERE `+b.String()+` ORDER BY logical_packet_key, observed_at
		LIMIT `+lim, b.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s PositionSample
		var raw []byte
		if err := rows.Scan(&s.At, &s.Signature, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		_ = json.Unmarshal(raw, &s)
		d.Positions = append(d.Positions, s)
	}
	rows.Close()
	if len(d.Positions) > maxSamples {
		d.Positions, d.Truncated = d.Positions[:maxSamples], true
	}
	sortByTime(d.Positions, func(s PositionSample) time.Time { return s.At })

	// Device telemetry series.
	b = where(w).filters(f).and("source_node_id = ?", n).and("packet_type = 'telemetry'").and("decoded_metadata->'telemetry'->>'kind' = 'device'")
	lim = b.arg(maxSamples + 1)
	rows, err = pool.Query(ctx, `
		SELECT DISTINCT ON (logical_packet_key) observed_at, decoded_metadata->'telemetry'
		FROM packet_log WHERE `+b.String()+` ORDER BY logical_packet_key, observed_at
		LIMIT `+lim, b.args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s TelemetrySample
		var raw []byte
		if err := rows.Scan(&s.At, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		_ = json.Unmarshal(raw, &s)
		d.TelemetrySeries = append(d.TelemetrySeries, s)
	}
	rows.Close()
	if len(d.TelemetrySeries) > maxSamples {
		d.TelemetrySeries, d.Truncated = d.TelemetrySeries[:maxSamples], true
	}
	sortByTime(d.TelemetrySeries, func(s TelemetrySample) time.Time { return s.At })

	var herr error
	if d.HeardBy, herr = hearings(ctx, pool, w, f, "source_node_id", "gateway_node_id", n); herr != nil {
		return nil, herr
	}
	if d.Heard, herr = hearings(ctx, pool, w, f, "gateway_node_id", "source_node_id", n); herr != nil {
		return nil, herr
	}

	// Recent unique packets.
	b = where(w).filters(f).and("source_node_id = ?", n)
	lim = b.arg(maxPackets)
	rows, err = pool.Query(ctx, `
		SELECT min(observed_at), min(packet_type), min(packet_id), min(destination_node_id), min(channel_name),
		       min(signature_status), min(decoded_metadata->>'crypto'), count(DISTINCT observation_key),
		       min((decoded_metadata->>'bytes')::int)
		FROM packet_log WHERE `+b.String()+`
		GROUP BY logical_packet_key ORDER BY 1 DESC LIMIT `+lim, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p PacketSummary
		var pid, to *int64
		var ch, crypto *string
		var bytes *int
		if err := rows.Scan(&p.At, &p.Type, &pid, &to, &ch, &p.Signature, &crypto, &p.Receptions, &bytes); err != nil {
			return nil, err
		}
		if pid != nil {
			p.PacketID = uint32(*pid)
		}
		if to != nil && *to != 0 {
			if uint32(*to) == protocol.Broadcast {
				p.To = "broadcast"
			} else {
				p.To = protocol.NodeID(uint32(*to))
			}
		}
		if ch != nil {
			p.Channel = *ch
		}
		if crypto != nil {
			p.Crypto = *crypto
		}
		if bytes != nil {
			p.Bytes = *bytes
		}
		d.Recent = append(d.Recent, p)
	}
	return d, rows.Err()
}

// hearings groups receptions by the other side (gateway or source).
func hearings(ctx context.Context, pool *pgxpool.Pool, w window.Window, f Filters, selfCol, otherCol string, n int64) ([]Hearing, error) {
	b := where(w).filters(f).and(selfCol+" = ?", n).and(otherCol + " IS NOT NULL").and(otherCol + " <> " + selfCol)
	lim := b.arg(maxGatewayed)
	// One row per reception (deliveries collapsed by observation_key).
	rows, err := pool.Query(ctx, `
		WITH rx AS (
			SELECT DISTINCT ON (observation_key) `+otherCol+` AS other, observed_at,
			       (decoded_metadata->'rx'->>'direct_rf')::boolean AS direct, rx_snr, rx_rssi
			FROM packet_log WHERE `+b.String()+` ORDER BY observation_key, id
		)
		SELECT other, count(*), count(*) FILTER (WHERE direct), max(observed_at),
		       count(rx_snr) FILTER (WHERE direct),
		       percentile_cont(0.5) WITHIN GROUP (ORDER BY rx_snr) FILTER (WHERE direct),
		       min(rx_snr) FILTER (WHERE direct), max(rx_snr) FILTER (WHERE direct),
		       (array_agg(rx_snr ORDER BY observed_at DESC) FILTER (WHERE direct AND rx_snr IS NOT NULL))[1],
		       count(rx_rssi) FILTER (WHERE direct),
		       percentile_cont(0.5) WITHIN GROUP (ORDER BY rx_rssi) FILTER (WHERE direct),
		       min(rx_rssi) FILTER (WHERE direct), max(rx_rssi) FILTER (WHERE direct),
		       (array_agg(rx_rssi ORDER BY observed_at DESC) FILTER (WHERE direct AND rx_rssi IS NOT NULL))[1]
		FROM rx GROUP BY other ORDER BY 2 DESC LIMIT `+lim, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Hearing{}
	for rows.Next() {
		var h Hearing
		var other int64
		var snrMin, snrMax, snrLast *float32
		var rssiMin, rssiMax, rssiLast *int32
		if err := rows.Scan(&other, &h.Receptions, &h.DirectRF, &h.LastAt,
			&h.SNR.N, &h.SNR.Median, &snrMin, &snrMax, &snrLast,
			&h.RSSI.N, &h.RSSI.Median, &rssiMin, &rssiMax, &rssiLast); err != nil {
			return nil, err
		}
		h.Node = protocol.NodeID(uint32(other))
		h.SNR.Min, h.SNR.Max, h.SNR.Last = f32(snrMin), f32(snrMax), f32(snrLast)
		h.RSSI.Min, h.RSSI.Max, h.RSSI.Last = i32(rssiMin), i32(rssiMax), i32(rssiLast)
		out = append(out, h)
	}
	return out, rows.Err()
}

func f32(p *float32) *float64 {
	if p == nil {
		return nil
	}
	v := float64(*p)
	return &v
}

func i32(p *int32) *float64 {
	if p == nil {
		return nil
	}
	v := float64(*p)
	return &v
}

func sortByTime[T any](s []T, at func(T) time.Time) {
	slices.SortStableFunc(s, func(a, b T) int { return at(a).Compare(at(b)) })
}
