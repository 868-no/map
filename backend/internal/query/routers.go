package query

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/protocol/ports"
	"github.com/868-no/map/internal/window"
)

// RouterSite is where a live router last reported itself.
type RouterSite struct {
	Node     uint32
	Lat, Lon float64
}

// RouterSites are the nodes whose latest role announcement (NodeInfo or map
// report) in w is ROUTER or ROUTER_LATE, that sent anything in alive, with
// their latest reported position in w. The server keeps their weather ready
// (D-133); routers that fell silent, or stopped being routers, drop out.
func RouterSites(ctx context.Context, pool *pgxpool.Pool, w, alive window.Window) ([]RouterSite, error) {
	role := `COALESCE(decoded_metadata->'nodeinfo'->>'role', decoded_metadata->'mapreport'->>'role', '')`
	q := fmt.Sprintf(`
	WITH roles AS (
		SELECT DISTINCT ON (source_node_id) source_node_id AS node, %[1]s AS role
		FROM packet_log
		WHERE %[2]s AND packet_type IN ('%[4]s', '%[5]s') AND %[1]s <> ''
		ORDER BY source_node_id, observed_at DESC, id DESC
	), live AS (
		SELECT DISTINCT source_node_id AS node
		FROM packet_log
		WHERE %[3]s AND packet_type <> '%[6]s'
		  AND source_node_id IN (SELECT node FROM roles WHERE role IN ('ROUTER', 'ROUTER_LATE'))
	), pos AS (
		SELECT DISTINCT ON (source_node_id) source_node_id AS node,
		       (decoded_metadata->'position'->>'lat')::float8 AS lat, (decoded_metadata->'position'->>'lon')::float8 AS lon
		FROM packet_log
		WHERE %[2]s AND packet_type IN ('%[7]s', '%[5]s') AND decoded_metadata ? 'position'
		  AND source_node_id IN (SELECT node FROM live)
		ORDER BY source_node_id, observed_at DESC, id DESC
	)
	SELECT node, lat, lon FROM pos WHERE NOT (lat = 0 AND lon = 0) ORDER BY node`,
		role, window.Predicate(1, 2), window.Predicate(3, 4), ports.TypeNodeInfo, ports.TypeMapReport, ports.TypeInvalid, ports.TypePosition)
	ws, we := w.Args()
	as, ae := alive.Args()
	rows, err := pool.Query(ctx, q, ws, we, as, ae)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (RouterSite, error) {
		var s RouterSite
		var n int64
		err := r.Scan(&n, &s.Lat, &s.Lon)
		s.Node = uint32(n)
		return s, err
	})
}
