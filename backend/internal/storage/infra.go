package storage

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// InfraNode is an infrastructure node's newest reported position.
type InfraNode struct {
	Node     uint32
	Lat, Lon float64
	Alt      *float64 // m above sea level; nil when not reported
}

// InfraPositions returns, for every node whose newest role since `since` is
// ROUTER, ROUTER_LATE or CLIENT_BASE, its newest reported position (Position
// packets and map reports) since then. The terrain warmer fetches heights
// between them before anyone asks (D-144). A background lookup, so it does
// not use window.Predicate.
func InfraPositions(ctx context.Context, pool *pgxpool.Pool, since time.Time) ([]InfraNode, error) {
	rows, err := pool.Query(ctx, `
		WITH pos AS (
			SELECT DISTINCT ON (source_node_id) source_node_id,
			       (decoded_metadata->'position'->>'lat')::float8 AS lat,
			       (decoded_metadata->'position'->>'lon')::float8 AS lon,
			       (decoded_metadata->'position'->>'alt')::float8 AS alt
			FROM packet_log
			WHERE observed_at >= $1 AND packet_type IN ('position', 'mapreport')
			  AND decoded_metadata ? 'position'
			ORDER BY source_node_id, observed_at DESC
		), role AS (
			SELECT DISTINCT ON (source_node_id) source_node_id,
			       COALESCE(decoded_metadata->'nodeinfo'->>'role', decoded_metadata->'mapreport'->>'role') AS role
			FROM packet_log
			WHERE observed_at >= $1 AND packet_type IN ('nodeinfo', 'mapreport')
			  AND (decoded_metadata->'nodeinfo' ? 'role' OR decoded_metadata->'mapreport' ? 'role')
			ORDER BY source_node_id, observed_at DESC
		)
		SELECT p.source_node_id, p.lat, p.lon, p.alt
		FROM pos p JOIN role r USING (source_node_id)
		WHERE r.role IN ('ROUTER', 'ROUTER_LATE', 'CLIENT_BASE')
		ORDER BY p.source_node_id`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []InfraNode
	for rows.Next() {
		var n InfraNode
		var id int64
		if err := rows.Scan(&id, &n.Lat, &n.Lon, &n.Alt); err != nil {
			return nil, err
		}
		n.Node = uint32(id)
		// Meshtastic sends 0 when it has no altitude.
		if n.Alt != nil && *n.Alt == 0 {
			n.Alt = nil
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
