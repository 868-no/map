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

// InfraNode is an infrastructure node (a router): its newest role, its
// newest reported position, and whether it was heard lately.
type InfraNode struct {
	Node     uint32
	Role     string // ROUTER or ROUTER_LATE
	Lat, Lon float64
	Alt      *float64 // m above sea level; nil when not reported
	Heard    bool     // sent anything but an invalid packet since the roster's alive time
}

// Router is a role that rebroadcasts everything it hears: the nodes whose
// weather is kept ready (D-133).
func (n InfraNode) Router() bool { return n.Role == "ROUTER" || n.Role == "ROUTER_LATE" }

// InfraRoles are the roles of infrastructure nodes (D-144): the routers,
// which the page draws line of sight between and shows weather at. Base
// stations (CLIENT_BASE) are placed to stay too, but the page asks for
// neither at them, so warming them would be work nobody uses.
var InfraRoles = []string{"ROUTER", "ROUTER_LATE"}

// Infrastructure returns every node whose newest role announcement (NodeInfo
// or map report; never an unsigned NodeInfo marked identity_untrusted, which
// is not used for roles, §2.4) in w is one of InfraRoles and that reported a
// position in w
// (Position packets and map reports, the newest by time then id; 0,0 is no
// position). Heard is whether it sent anything but an invalid packet since
// alive. One definition serves the weather kept ready for live routers
// (D-133) and the terrain heights warmed between routers (D-144).
func Infrastructure(ctx context.Context, pool *pgxpool.Pool, w window.Window, alive time.Time) ([]InfraNode, error) {
	role := `COALESCE(decoded_metadata->'nodeinfo'->>'role', decoded_metadata->'mapreport'->>'role', '')`
	q := fmt.Sprintf(`
	WITH roles AS (
		SELECT DISTINCT ON (source_node_id) source_node_id AS node, %[1]s AS role
		FROM packet_log
		WHERE %[2]s AND packet_type IN ('%[3]s', '%[4]s') AND %[1]s <> ''
		  AND NOT COALESCE((decoded_metadata->'nodeinfo'->>'identity_untrusted')::boolean, false)
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
	), heard AS (
		-- One pass over the alive window for every node, not one per node.
		SELECT DISTINCT source_node_id AS node
		FROM packet_log
		WHERE %[7]s AND packet_type <> '%[6]s' AND source_node_id IN (SELECT node FROM infra)
	)
	SELECT i.node, i.role, p.lat, p.lon, p.alt, h.node IS NOT NULL
	FROM infra i JOIN pos p USING (node) LEFT JOIN heard h USING (node)
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
