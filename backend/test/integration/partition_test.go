//go:build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/868-no/map/internal/ingest"
	pb "github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/storage"
)

// D-056: a batch retried after its commit succeeded (but the writer saw an
// error) gets the first attempt's ids and stores nothing twice.
func TestInsertBatchRetryStoresOnce(t *testing.T) {
	pool := freshDB(t)
	f := newFixture(t, pool)
	at := time.Now().UTC().Add(-time.Minute)
	b := []*ingest.Observation{
		f.observation(at, 0x1001, 0x2001, &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("a")}, nil),
		f.observation(at, 0x1002, 0x2001, &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("b")}, nil),
	}
	first, err := storage.InsertBatch(context.Background(), pool, b)
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, f.observation(at, 0x1003, 0x2001, &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("c")}, nil))
	again, err := storage.InsertBatch(context.Background(), pool, b)
	if err != nil {
		t.Fatal(err)
	}
	if again[0] != first[0] || again[1] != first[1] || again[2] == 0 || again[2] == first[0] || again[2] == first[1] {
		t.Fatalf("ids first %v, retry %v", first, again)
	}
	if n := count(t, pool, `SELECT count(*) FROM packet_log`); n != 3 {
		t.Fatalf("%d rows, want 3", n)
	}
}

// D-056: a schema-1 table (plain, identity id) becomes the partitioned
// table at startup, keeping ids, one row per reception, and the sequence.
func TestMigrateSchema1(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DROP TABLE packet_log; DROP SEQUENCE IF EXISTS packet_log_id_seq`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, schema1); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO packet_log (observed_at, broker_id, mqtt_topic, source_node_id, packet_type, logical_packet_key, observation_key, signature_status, decode_version, envelope_bytes)
		VALUES ('2026-08-15T10:00:00Z', 'a', 't', 1, 'other', '\x01', '\x0a', 'unsigned', 1, '\x00'),
		       ('2026-08-15T10:00:00Z', 'b', 't', 1, 'other', '\x01', '\x0a', 'unsigned', 1, '\x00'),
		       ('2026-09-02T10:00:00Z', 'a', 't', 2, 'other', '\x02', '\x0b', 'unsigned', 1, '\x00')`); err != nil {
		t.Fatal(err)
	}
	if err := storage.InitSchema(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := storage.CheckSchema(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, `SELECT count(*) FROM pg_class WHERE relname = 'packet_log' AND relkind = 'p'`); n != 1 {
		t.Fatal("packet_log is not partitioned")
	}
	if n := count(t, pool, `SELECT count(*) FROM pg_class WHERE relname = 'packet_log_schema1'`); n != 0 {
		t.Fatal("old table left behind")
	}
	// The duplicate reception (id 2) is gone; ids 1 and 3 are kept.
	if n := count(t, pool, `SELECT count(*) FROM packet_log WHERE id IN (1, 3)`); n != 2 || count(t, pool, `SELECT count(*) FROM packet_log`) != 2 {
		t.Fatal("rows not copied with their ids, one per reception")
	}
	months, err := storage.Partitions(ctx, pool)
	if err != nil || len(months) < 2 || months[0].Month() != time.August {
		t.Fatalf("partitions %v %v", months, err)
	}
	f := newFixture(t, pool)
	f.position(time.Now().UTC().Add(-time.Minute), 0x1001, 0x2001, 63.4)
	if n := count(t, pool, `SELECT max(id) FROM packet_log`); n <= 3 {
		t.Fatalf("sequence not moved past copied ids: new id %d", n)
	}
	if err := storage.InitSchema(ctx, pool); err != nil { // idempotent afterwards
		t.Fatal(err)
	}
}

// schema1 is schema.sql as of schema version 1 (before D-056).
const schema1 = `-- meshmap schema. The ONLY application table is packet_log (spec §5).
-- Every statement is idempotent; init-schema runs it under an advisory lock.
-- The schema version lives in the table comment, not in a migrations table.

CREATE TABLE IF NOT EXISTS packet_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observed_at         TIMESTAMPTZ NOT NULL,
    broker_id           TEXT NOT NULL,
    mqtt_topic          TEXT NOT NULL,
    gateway_node_id     BIGINT,
    source_node_id      BIGINT NOT NULL,
    destination_node_id BIGINT,
    packet_id           BIGINT,
    channel_name        TEXT,
    portnum             INTEGER,
    packet_type         TEXT NOT NULL,
    logical_packet_key  BYTEA NOT NULL,
    observation_key     BYTEA NOT NULL,
    rx_time             TIMESTAMPTZ,
    rx_snr              REAL,
    rx_rssi             INTEGER,
    hop_start           SMALLINT,
    hop_limit           SMALLINT,
    relay_hint          INTEGER,
    transport_kind      TEXT,
    signature_status    TEXT NOT NULL,
    decode_version      INTEGER NOT NULL,
    envelope_bytes      BYTEA NOT NULL,
    decoded_metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT packet_log_signature_status_chk
        CHECK (signature_status IN ('verified', 'unsigned', 'unverifiable', 'not-applicable')),
    CONSTRAINT packet_log_node_ids_chk
        CHECK (source_node_id BETWEEN 1 AND 4294967294
               AND (gateway_node_id IS NULL OR gateway_node_id BETWEEN 1 AND 4294967294)
               AND (destination_node_id IS NULL OR destination_node_id BETWEEN 0 AND 4294967295))
) WITH (fillfactor = 90);

-- The row as /observations serves it, minus its id (ingest.EncodeTail), so
-- reads need not decode decoded_metadata (D-046). Derived data only: rows of
-- another obs_row_version (or none) are served from the columns above and
-- rebuilt in the background, so a logic change never leaves stale copies.
ALTER TABLE packet_log ADD COLUMN IF NOT EXISTS obs_row TEXT;
ALTER TABLE packet_log ADD COLUMN IF NOT EXISTS obs_row_version SMALLINT;

-- Leave room on each page so late broker-provenance updates (also_via) are
-- HOT updates without index writes. Applies to pages written from now on.
ALTER TABLE packet_log SET (fillfactor = 90);

-- Serves every /observations page ((observed_at, id) keyset order, D-038).
CREATE INDEX IF NOT EXISTS packet_log_time_idx        ON packet_log (observed_at DESC, id DESC);
-- Identity rebuild at startup (latest verified NodeInfo per node).
CREATE INDEX IF NOT EXISTS packet_log_source_time_idx ON packet_log (source_node_id, observed_at DESC);
-- Ingest dedupe: id lookup by observation key.
CREATE INDEX IF NOT EXISTS packet_log_observation_idx ON packet_log (observation_key, observed_at DESC);
-- Identity rebuild at startup (verified NodeInfo rows).
CREATE INDEX IF NOT EXISTS packet_log_type_time_idx   ON packet_log (packet_type, observed_at DESC);
-- Cheap range pruning for retention deletes.
CREATE INDEX IF NOT EXISTS packet_log_brin            ON packet_log USING BRIN (observed_at);
-- Served only the retired server views (D-041); every insert paid for them.
DROP INDEX IF EXISTS packet_log_gateway_time_idx;
DROP INDEX IF EXISTS packet_log_logical_idx;

COMMENT ON TABLE packet_log IS 'meshmap-schema:1';
`
