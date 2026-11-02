-- meshmap schema. The ONLY application table is packet_log (design §3.1),
-- range-partitioned by month on observed_at (D-056): retention drops whole
-- months instead of deleting and vacuuming rows. Partitions are created by
-- storage.EnsurePartitions, never by hand.
-- Every statement is idempotent; init-schema runs it under an advisory lock
-- (after migrating an unpartitioned table from schema 1, see migrate.go).
-- The schema version lives in the table comment, not in a migrations table.

-- PostgreSQL 16 has no identity columns on partitioned tables: a sequence.
CREATE SEQUENCE IF NOT EXISTS packet_log_id_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS packet_log (
    id                  BIGINT NOT NULL DEFAULT nextval('packet_log_id_seq'),
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
    -- The row as /observations serves it, minus its id (obsrow.EncodeTail),
    -- so reads need not decode decoded_metadata (D-046). Derived data only:
    -- rows of another obs_row_version (or none) are served from the columns
    -- above and rebuilt in the background, so a logic change never leaves
    -- stale copies.
    obs_row             TEXT,
    obs_row_version     SMALLINT,
    -- The partition key must be part of every unique constraint.
    CONSTRAINT packet_log_pkey PRIMARY KEY (id, observed_at),
    CONSTRAINT packet_log_signature_status_chk
        CHECK (signature_status IN ('verified', 'unsigned', 'unverifiable', 'not-applicable')),
    CONSTRAINT packet_log_node_ids_chk
        CHECK (source_node_id BETWEEN 1 AND 4294967294
               AND (gateway_node_id IS NULL OR gateway_node_id BETWEEN 1 AND 4294967294)
               AND (destination_node_id IS NULL OR destination_node_id BETWEEN 0 AND 4294967295))
) PARTITION BY RANGE (observed_at);

ALTER SEQUENCE packet_log_id_seq OWNED BY packet_log.id;

-- Serves every /observations page ((observed_at, id) keyset order, D-038)
-- and the retention delete inside the oldest kept month.
CREATE INDEX IF NOT EXISTS packet_log_time_idx        ON packet_log (observed_at DESC, id DESC);
-- Identity rebuild (verified NodeInfo rows, per node in id order): partial,
-- so other inserts never touch it. It replaces two full indexes on
-- (source_node_id, observed_at) and (packet_type, observed_at), which served
-- only this query.
CREATE INDEX IF NOT EXISTS packet_log_verified_nodeinfo_idx ON packet_log (source_node_id, id)
  WHERE packet_type = 'nodeinfo' AND signature_status = 'verified';
DROP INDEX IF EXISTS packet_log_source_time_idx;
DROP INDEX IF EXISTS packet_log_type_time_idx;
-- One row per reception (D-056): a batch retried after a commit whose
-- outcome was lost inserts nothing twice. Also the ingest dedupe lookup.
CREATE UNIQUE INDEX IF NOT EXISTS packet_log_observation_key ON packet_log (observation_key, observed_at);

COMMENT ON TABLE packet_log IS 'meshmap-schema:2';
