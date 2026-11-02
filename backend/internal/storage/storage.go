// Package storage owns packet_log: idempotent schema initialisation, batch
// inserts and the few ingestion-side lookups. Window-scoped read queries live
// in package query and always go through window.Predicate.
package storage

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
)

//go:embed schema.sql
var schemaSQL string

// SchemaVersion is the value stored in the packet_log table comment.
const SchemaVersion = "meshmap-schema:2"

// Open creates a connection pool and verifies connectivity.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("database url: %w", err)
	}
	cfg.MaxConns = 16
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.RuntimeParams["application_name"] = "meshmap"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return pool, nil
}

// InitSchema applies schema.sql under a session advisory lock so concurrent
// starters do not race. Idempotent; no migrations table.
func InitSchema(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('meshmap:schema'))`); err != nil {
		return err
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext('meshmap:schema'))`) //nolint:errcheck
	forgetPartitions()
	if n, err := migrateUnpartitioned(ctx, conn, schemaSQL); err != nil {
		return fmt.Errorf("partition packet_log: %w", err)
	} else if n > 0 {
		slog.Default().Info("packet_log partitioned by month", "rows", n)
	}
	if _, err := conn.Exec(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	now := time.Now()
	return EnsurePartitions(ctx, conn, now.AddDate(0, -1, 0), now.AddDate(0, 2, 0))
}

// CheckSchema verifies the schema version and that packet_log is the only
// application table (design §1.2, invariant 2).
func CheckSchema(ctx context.Context, pool *pgxpool.Pool) error {
	var comment *string
	if err := pool.QueryRow(ctx, `SELECT obj_description(to_regclass('public.packet_log'), 'pg_class')`).Scan(&comment); err != nil {
		return err
	}
	if comment == nil || *comment != SchemaVersion {
		return fmt.Errorf("packet_log schema version mismatch (want %s)", SchemaVersion)
	}
	tables, err := ApplicationTables(ctx, pool)
	if err != nil {
		return err
	}
	if len(tables) != 1 || tables[0] != "packet_log" {
		return fmt.Errorf("unexpected application tables: %s", strings.Join(tables, ", "))
	}
	return nil
}

// ApplicationTables lists tables in the public schema, counting a
// partitioned table once (its partitions are not separate tables).
func ApplicationTables(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

var columns = []string{
	"observed_at", "broker_id", "mqtt_topic", "gateway_node_id", "source_node_id", "destination_node_id",
	"packet_id", "channel_name", "portnum", "packet_type", "logical_packet_key", "observation_key",
	"rx_time", "rx_snr", "rx_rssi", "hop_start", "hop_limit", "relay_hint", "transport_kind",
	"signature_status", "decode_version", "envelope_bytes", "decoded_metadata", "obs_row", "obs_row_version",
}

func optU32(p *uint32) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Row converts an observation to COPY values.
func Row(o *ingest.Observation) ([]any, error) {
	meta, err := json.Marshal(o.Meta)
	if err != nil {
		return nil, err
	}
	tail, err := obsrow.EncodeTail(ingest.RowOf(o, 0, meta))
	if err != nil {
		return nil, err
	}
	return []any{
		o.ObservedAt, o.BrokerID, o.Topic, optU32(o.Gateway), int64(o.Source), optU32(o.Destination),
		int64(o.PacketID), nullStr(o.Channel), o.Portnum, o.PacketType, o.LogicalKey[:], o.ObservationKey[:],
		o.RxTime, o.RxSNR, o.RxRSSI, o.HopStart, o.HopLimit, o.RelayHint, nullStr(o.Transport),
		string(o.SignatureStatus), ingest.DecodeVersion, o.EnvelopeBytes, meta, string(tail), int16(obsrow.Version),
	}, nil
}

func joinColumns() string { return strings.Join(columns, ", ") }

// stageTable is a per-connection temporary table InsertBatch copies into;
// its name follows the column list so a schema change never reuses an old
// one on a pooled connection.
var stageTable = fmt.Sprintf("packet_log_stage_%08x", crc32.ChecksumIEEE([]byte(joinColumns())))

// InsertBatch writes observations in one transaction and returns their row
// ids in input order (needed for identity binding rows). Rows go in by COPY
// to a staging table, then into packet_log skipping receptions already
// stored (D-056): a batch retried after a commit whose outcome was lost gets
// the ids of its first attempt instead of a second copy.
func InsertBatch(ctx context.Context, pool *pgxpool.Pool, obs []*ingest.Observation) ([]int64, error) {
	if len(obs) == 0 {
		return nil, nil
	}
	lo, hi := obs[0].ObservedAt, obs[0].ObservedAt
	rows := make([][]any, 0, len(obs))
	for _, o := range obs {
		r, err := Row(o)
		if err != nil {
			return nil, err
		}
		rows = append(rows, r)
		lo, hi = minTime(lo, o.ObservedAt), maxTime(hi, o.ObservedAt)
	}
	if err := EnsurePartitions(ctx, pool, lo, hi); err != nil {
		return nil, err
	}
	ids, err := insertBatch(ctx, pool, obs, rows)
	if err != nil && strings.Contains(err.Error(), "no partition of relation") {
		// A month this process remembered is gone (dropped elsewhere):
		// re-check the catalog and try once more.
		forgetPartitions()
		if err := EnsurePartitions(ctx, pool, lo, hi); err != nil {
			return nil, err
		}
		ids, err = insertBatch(ctx, pool, obs, rows)
	}
	return ids, err
}

func insertBatch(ctx context.Context, pool *pgxpool.Pool, obs []*ingest.Observation, rows [][]any) ([]int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx)) //nolint:errcheck
	cols := joinColumns()
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE IF NOT EXISTS `+stageTable+` ON COMMIT DELETE ROWS AS
		SELECT `+cols+` FROM packet_log WITH NO DATA`); err != nil {
		return nil, err
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{stageTable}, columns, pgx.CopyFromRows(rows)); err != nil {
		return nil, err
	}
	byKey := make(map[string]int64, len(obs))
	collect := func(q string) error {
		r, err := tx.Query(ctx, q)
		if err != nil {
			return err
		}
		for r.Next() {
			var id int64
			var k []byte
			if err := r.Scan(&id, &k); err != nil {
				r.Close()
				return err
			}
			byKey[string(k)] = id
		}
		return r.Err()
	}
	if err := collect(`INSERT INTO packet_log (` + cols + `) SELECT ` + cols + ` FROM ` + stageTable + `
		ON CONFLICT (observation_key, observed_at) DO NOTHING RETURNING id, observation_key`); err != nil {
		return nil, err
	}
	if len(byKey) < len(obs) {
		// Already stored: an earlier attempt of this batch did commit.
		if err := collect(`SELECT p.id, p.observation_key FROM packet_log p JOIN ` + stageTable + ` s
			ON p.observation_key = s.observation_key AND p.observed_at = s.observed_at`); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	ids := make([]int64, len(obs))
	for i, o := range obs {
		ids[i] = byKey[string(o.ObservationKey[:])]
	}
	return ids, nil
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// RecentObservation is the dedupe fallback when Redis is unavailable: the
// row id of a recently stored observation.
func RecentObservation(ctx context.Context, pool *pgxpool.Pool, key [16]byte, since time.Time) (int64, bool, error) {
	var id int64
	err := pool.QueryRow(ctx, `SELECT id FROM packet_log WHERE observation_key = $1 AND observed_at >= $2 ORDER BY id LIMIT 1`, key[:], since).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, err
}

// AddAlsoVia records late cross-broker deliveries of committed rows in
// decoded_metadata.also_via with one statement. Brokers already present
// (the row's broker_id or an existing also_via entry) are not added again,
// and rows needing no change are not rewritten. Only decoded_metadata
// changes, so with fillfactor 90 most updates are HOT (no index writes).
// also_via is not part of ObsRow, so obs_row stays valid. All rows were
// observed at or after since: the bound lets Postgres skip older partitions
// instead of probing every partition's primary key for each id.
func AddAlsoVia(ctx context.Context, pool *pgxpool.Pool, byRow map[int64][]string, since time.Time) (int64, error) {
	if len(byRow) == 0 {
		return 0, nil
	}
	ids := make([]int64, 0, len(byRow))
	lists := make([]string, 0, len(byRow))
	for id, brokers := range byRow {
		ids = append(ids, id)
		lists = append(lists, strings.Join(brokers, ",")) // broker ids match [A-Za-z0-9_.-]
	}
	tag, err := pool.Exec(ctx, `
		WITH v AS (
			SELECT u.id, string_to_array(u.brokers, ',') AS brokers
			FROM unnest($1::bigint[], $2::text[]) AS u(id, brokers)
		)
		UPDATE packet_log p
		SET decoded_metadata = jsonb_set(p.decoded_metadata, '{also_via}', (
			SELECT to_jsonb(array_agg(DISTINCT b ORDER BY b))
			FROM (
				SELECT jsonb_array_elements_text(COALESCE(p.decoded_metadata->'also_via', '[]'::jsonb)) AS b
				UNION
				SELECT unnest(v.brokers)
			) s
			WHERE b <> p.broker_id))
		FROM v
		WHERE p.id = v.id AND p.observed_at >= $3
		  AND EXISTS (
			SELECT 1 FROM unnest(v.brokers) nb
			WHERE nb <> p.broker_id AND NOT (COALESCE(p.decoded_metadata->'also_via', '[]'::jsonb) ? nb))`,
		ids, lists, since)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// IdentityRow is a verified NodeInfo binding stored in packet_log.
type IdentityRow struct {
	Node      uint32
	PublicKey string // base64
	Since     time.Time
	RowID     int64
}

// VerifiedIdentities returns, per node, the earliest retained verified
// NodeInfo binding (TOFU: the first authoritative key wins). Public keys are
// public data stored in decoded_metadata (plan amendment 3).
//
// This is an ingestion-side lookup over the whole retained log, never used to
// fill a historical view, so it deliberately does not use window.Predicate.
func VerifiedIdentities(ctx context.Context, pool *pgxpool.Pool, node *uint32) ([]IdentityRow, error) {
	q := `SELECT DISTINCT ON (source_node_id) source_node_id, decoded_metadata->'nodeinfo'->>'public_key', observed_at, id
	      FROM packet_log
	      WHERE packet_type = 'nodeinfo' AND signature_status = 'verified'
	        AND decoded_metadata->'nodeinfo' ? 'public_key'`
	args := []any{}
	if node != nil {
		q += ` AND source_node_id = $1`
		args = append(args, int64(*node))
	}
	q += ` ORDER BY source_node_id, id ASC`
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IdentityRow
	for rows.Next() {
		var r IdentityRow
		var n int64
		if err := rows.Scan(&n, &r.PublicKey, &r.Since, &r.RowID); err != nil {
			return nil, err
		}
		r.Node = uint32(n)
		out = append(out, r)
	}
	return out, rows.Err()
}

// AnnouncedKey is a node's public key as its NodeInfo carried it.
type AnnouncedKey struct {
	PublicKey string // base64
	At        time.Time
	Signature string
}

// LatestAnnouncedKey returns the public key in the node's newest retained
// NodeInfo that carried one, or ErrNotFound. Like VerifiedIdentities it
// spans the whole retained log: a key identifies a node, not a window.
func LatestAnnouncedKey(ctx context.Context, pool *pgxpool.Pool, node uint32) (AnnouncedKey, error) {
	var k AnnouncedKey
	err := pool.QueryRow(ctx, `SELECT decoded_metadata->'nodeinfo'->>'public_key', observed_at, signature_status
	      FROM packet_log
	      WHERE packet_type = 'nodeinfo' AND source_node_id = $1 AND decoded_metadata->'nodeinfo' ? 'public_key'
	      ORDER BY id DESC LIMIT 1`, int64(node)).Scan(&k.PublicKey, &k.At, &k.Signature)
	if errors.Is(err, pgx.ErrNoRows) {
		return k, ErrNotFound
	}
	return k, err
}

// ErrNotFound is returned by single-row lookups with no result.
var ErrNotFound = errors.New("not found")
