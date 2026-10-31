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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
)

//go:embed schema.sql
var schemaSQL string

// SchemaVersion is the value stored in the packet_log table comment.
const SchemaVersion = "meshmap-schema:1"

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
	if _, err := conn.Exec(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	return nil
}

// CheckSchema verifies the schema version and that packet_log is the only
// application table (spec invariant 2).
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

// ApplicationTables lists ordinary tables in the public schema.
func ApplicationTables(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

var columns = []string{
	"observed_at", "broker_id", "mqtt_topic", "gateway_node_id", "source_node_id", "destination_node_id",
	"packet_id", "channel_name", "portnum", "packet_type", "logical_packet_key", "observation_key",
	"rx_time", "rx_snr", "rx_rssi", "hop_start", "hop_limit", "relay_hint", "transport_kind",
	"signature_status", "decode_version", "envelope_bytes", "decoded_metadata",
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
	return []any{
		o.ObservedAt, o.BrokerID, o.Topic, optU32(o.Gateway), int64(o.Source), optU32(o.Destination),
		int64(o.PacketID), nullStr(o.Channel), o.Portnum, o.PacketType, o.LogicalKey[:], o.ObservationKey[:],
		o.RxTime, o.RxSNR, o.RxRSSI, o.HopStart, o.HopLimit, o.RelayHint, nullStr(o.Transport),
		string(o.SignatureStatus), ingest.DecodeVersion, o.EnvelopeBytes, meta,
	}, nil
}

// InsertBatch writes observations in one transaction via COPY and returns
// the assigned ids in input order (needed for identity binding rows).
func InsertBatch(ctx context.Context, pool *pgxpool.Pool, obs []*ingest.Observation) ([]int64, error) {
	if len(obs) == 0 {
		return nil, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx)) //nolint:errcheck
	var before int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(id), 0) FROM packet_log`).Scan(&before); err != nil {
		return nil, err
	}
	rows := make([][]any, 0, len(obs))
	for _, o := range obs {
		r, err := Row(o)
		if err != nil {
			return nil, err
		}
		rows = append(rows, r)
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"packet_log"}, columns, pgx.CopyFromRows(rows)); err != nil {
		return nil, err
	}
	// Identity columns are assigned in COPY order; read them back by key to
	// avoid depending on that.
	keys := make([][]byte, len(obs))
	for i, o := range obs {
		keys[i] = o.ObservationKey[:]
	}
	idRows, err := tx.Query(ctx, `SELECT id, observation_key FROM packet_log WHERE id > $1 AND observation_key = ANY($2)`, before, keys)
	if err != nil {
		return nil, err
	}
	byKey := map[string]int64{}
	for idRows.Next() {
		var id int64
		var k []byte
		if err := idRows.Scan(&id, &k); err != nil {
			return nil, err
		}
		byKey[string(k)] = id
	}
	if err := idRows.Err(); err != nil {
		return nil, err
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
func AddAlsoVia(ctx context.Context, pool *pgxpool.Pool, byRow map[int64][]string) (int64, error) {
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
		WHERE p.id = v.id
		  AND EXISTS (
			SELECT 1 FROM unnest(v.brokers) nb
			WHERE nb <> p.broker_id AND NOT (COALESCE(p.decoded_metadata->'also_via', '[]'::jsonb) ? nb))`,
		ids, lists)
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

// ErrNotFound is returned by single-row lookups with no result.
var ErrNotFound = errors.New("not found")
