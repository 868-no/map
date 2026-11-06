package storage

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/protocol/ports"
	"github.com/868-no/map/internal/window"
)

// InfraNode is an infrastructure node: its newest role, its newest reported
// position, and whether it was heard lately.
type InfraNode struct {
	Node     uint32
	Role     string // ROUTER, ROUTER_LATE or CLIENT_BASE
	Lat, Lon float64
	Alt      *float64 // m above sea level; nil when not reported
	Heard    bool     // sent anything but an invalid packet since the roster's alive time
}

// Router is a role that rebroadcasts everything it hears: the nodes whose
// weather is kept ready (D-133).
func (n InfraNode) Router() bool { return n.Role == "ROUTER" || n.Role == "ROUTER_LATE" }

// InfraRoles are the roles of infrastructure nodes, those placed to stay
// (D-144): routers and base stations.
var InfraRoles = []string{"ROUTER", "ROUTER_LATE", "CLIENT_BASE"}

// Infrastructure returns every node whose newest role announcement (NodeInfo
// or map report) in w is one of InfraRoles and that reported a position in w
// (Position packets and map reports, the newest by time then id; 0,0 is no
// position). Heard is whether it sent anything but an invalid packet since
// alive. One definition serves the weather kept ready for live routers
// (D-133) and the terrain heights warmed between infrastructure (D-144).
func Infrastructure(ctx context.Context, pool *pgxpool.Pool, w window.Window, alive time.Time) ([]InfraNode, error) {
	role := `COALESCE(decoded_metadata->'nodeinfo'->>'role', decoded_metadata->'mapreport'->>'role', '')`
	q := fmt.Sprintf(`
	WITH roles AS (
		SELECT DISTINCT ON (source_node_id) source_node_id AS node, %[1]s AS role
		FROM packet_log
		WHERE %[2]s AND packet_type IN ('%[3]s', '%[4]s') AND %[1]s <> ''
		ORDER BY source_node_id, observed_at DESC, id DESC
	), infra AS (
		SELECT node, role FROM roles WHERE role = ANY($3)
	), pos AS (
		SELECT DISTINCT ON (source_node_id) source_node_id AS node,
		       (decoded_metadata->'position'->>'lat')::float8 AS lat,
		       (decoded_metadata->'position'->>'lon')::float8 AS lon,
		       (decoded_metadata->'position'->>'alt')::float8 AS alt
		FROM packet_log
		WHERE %[2]s AND packet_type IN ('%[5]s', '%[4]s') AND decoded_metadata ? 'position'
		  AND source_node_id IN (SELECT node FROM infra)
		ORDER BY source_node_id, observed_at DESC, id DESC
	)
	SELECT i.node, i.role, p.lat, p.lon, p.alt,
	       EXISTS (SELECT 1 FROM packet_log l WHERE l.source_node_id = i.node AND %[7]s AND l.packet_type <> '%[6]s')
	FROM infra i JOIN pos p USING (node)
	WHERE NOT (p.lat = 0 AND p.lon = 0)
	ORDER BY i.node`,
		role, window.Predicate(1, 2), ports.TypeNodeInfo, ports.TypeMapReport, ports.TypePosition, ports.TypeInvalid, window.Predicate(4, 2))
	ws, we := w.Args()
	rows, err := pool.Query(ctx, q, ws, we, InfraRoles, alive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []InfraNode
	for rows.Next() {
		var n InfraNode
		var id int64
		if err := rows.Scan(&id, &n.Role, &n.Lat, &n.Lon, &n.Alt, &n.Heard); err != nil {
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

// Roster reads Infrastructure for its background users at most once per
// TTL: the weather keeper and the terrain warmer run on their own timers,
// and each would otherwise scan the same days of the log for the same nodes.
type Roster struct {
	Pool   *pgxpool.Pool
	Window time.Duration // how far back roles and positions are looked for
	Alive  time.Duration // how recently a node must be heard to count as heard
	TTL    time.Duration

	mu    sync.Mutex
	at    time.Time
	nodes []InfraNode
}

// Nodes is the roster as of at most TTL ago. Callers must not modify it.
func (r *Roster) Nodes(ctx context.Context) ([]InfraNode, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UTC()
	if !r.at.IsZero() && now.Sub(r.at) < r.TTL {
		return r.nodes, nil
	}
	nodes, err := Infrastructure(ctx, r.Pool, window.Window{Start: now.Add(-r.Window), End: now}, now.Add(-r.Alive))
	if err != nil {
		return nil, err
	}
	r.at, r.nodes = now, slices.Clip(nodes)
	return r.nodes, nil
}
