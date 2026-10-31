-- meshmap schema. The ONLY application table is packet_log (spec §5).
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
