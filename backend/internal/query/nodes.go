package query

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/window"
)

// NodeRow is one node's newest row of one packet type in a window, as
// LatestNodeRows reads it.
type NodeRow struct {
	Node uint32
	Type string // nodeinfo, position or mapreport
	At   time.Time
	Sig  string // signature_status
	Meta []byte // decoded_metadata
}

// LatestNodeRows reads, for every node heard in w, its newest NodeInfo, its
// newest Position packet and its newest map report: the stored facts behind
// /nodes, which unlike the map applies none of the browser's rules (D-212).
//
// Only rows whose content can be trusted as far as the protocol allows:
// NodeInfo and Position verified or unsigned (never signed by a key we do
// not hold, never failed), map reports (MQTT only, never signed) as they
// are; never a NodeInfo that claims another node's identity, and nothing a
// node did not allow onto MQTT (D-032). A position must have been decoded.
// Rows come ordered by node, then type.
func LatestNodeRows(ctx context.Context, pool *pgxpool.Pool, w window.Window) ([]NodeRow, error) {
	b := where(w).
		and(`packet_type IN ('nodeinfo', 'position', 'mapreport')`).
		and(`(packet_type = 'mapreport' OR signature_status IN ('verified', 'unsigned'))`).
		and(`NOT coalesce((decoded_metadata->>'not_ok_to_mqtt')::boolean, false)`).
		and(`coalesce(decoded_metadata->>'invalid', '') = ''`).
		and(`(packet_type = 'nodeinfo' OR decoded_metadata ? 'position')`).
		and(`(packet_type <> 'nodeinfo' OR (decoded_metadata ? 'nodeinfo' AND NOT coalesce((decoded_metadata->'nodeinfo'->>'identity_untrusted')::boolean, false)))`)
	rows, err := pool.Query(ctx, `SELECT DISTINCT ON (source_node_id, packet_type)
			source_node_id, packet_type, observed_at, signature_status, decoded_metadata
		FROM packet_log WHERE `+b.String()+`
		ORDER BY source_node_id, packet_type, observed_at DESC, id DESC`, b.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NodeRow
	for rows.Next() {
		var r NodeRow
		var n int64
		if err := rows.Scan(&n, &r.Type, &r.At, &r.Sig, &r.Meta); err != nil {
			return nil, err
		}
		r.Node = uint32(n)
		out = append(out, r)
	}
	return out, rows.Err()
}
