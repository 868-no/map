-- meshmap schema. The ONLY table of mesh data is packet_log (design §3.1),
-- range-partitioned by month on observed_at (D-056): retention drops whole
-- months instead of deleting and vacuuming rows. Partitions are created by
-- storage.EnsurePartitions, never by hand.
-- Every statement is idempotent; init-schema runs it under an advisory lock
-- and a lock timeout (after migrating an unpartitioned table from schema 1,
-- see partitions.go).
-- The schema version lives in the table comment, not in a migrations table.
-- The two other tables hold no mesh data: weather_hour weather (D-133),
-- terrain_height terrain heights (D-143).

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

-- The history revision (D-158): advanced when an import of recorded history
-- starts and ends, and part of the /observations generation, so no browser
-- or shared cache keeps a day from before an import. Not owned by the
-- table: it survives a rebuilt packet_log, and so never goes back.
CREATE SEQUENCE IF NOT EXISTS packet_log_history_rev AS BIGINT;

-- packet_log's indexes are created from Go, only when missing (stale.go):
-- CREATE INDEX IF NOT EXISTS would lock every partition on every start.
-- Indexes it no longer has:
DROP INDEX IF EXISTS packet_log_verified_nodeinfo_idx;
DROP INDEX IF EXISTS packet_log_source_time_idx;
DROP INDEX IF EXISTS packet_log_type_time_idx;

-- Weather at stationary routers (D-133): MET Norway's MET Nordic analysis
-- with gusts from MEPS, one row per 1 km analysis grid cell and hour, fetched once and kept for the
-- retention period. Not mesh data: nothing on the map is derived from it, and
-- it can always be fetched again. missing: the archive had no file for that
-- hour when fetched_at asked.
CREATE TABLE IF NOT EXISTS weather_hour (
    cell_x     SMALLINT NOT NULL,
    cell_y     SMALLINT NOT NULL,
    valid_at   TIMESTAMPTZ NOT NULL,
    temp_c       REAL,
    precip_mm    REAL,
    humidity_pct REAL,
    cloud_pct    REAL,
    sun_wm2      REAL,
    wind_ms      REAL,
    gust_ms      REAL, -- from MEPS: NULL until its run is archived, hours late
    missing      BOOLEAN NOT NULL DEFAULT false,
    fetched_at   TIMESTAMPTZ NOT NULL,
    -- weather.rowVersion when stored: older rows lack later quantities and are fetched again.
    version      SMALLINT NOT NULL DEFAULT 1,
    CONSTRAINT weather_hour_pkey PRIMARY KEY (cell_x, cell_y, valid_at)
);
-- Columns added after the table was first created.
ALTER TABLE weather_hour ADD COLUMN IF NOT EXISTS sun_wm2 REAL;
ALTER TABLE weather_hour ADD COLUMN IF NOT EXISTS version SMALLINT NOT NULL DEFAULT 1;

-- Terrain heights (D-143) from Kartverket's terrain model, on a grid of
-- 0.0005° (lat_k = round(lat / 0.0005)), for line-of-sight cross sections
-- between routers. Terrain does not change: rows are fetched once and kept,
-- and retention leaves them. z NULL: the model has no height there (abroad).
-- No node ids: it says nothing about the mesh.
CREATE TABLE IF NOT EXISTS terrain_height (
    lat_k INTEGER NOT NULL,
    lon_k INTEGER NOT NULL,
    z     REAL,
    CONSTRAINT terrain_height_pkey PRIMARY KEY (lat_k, lon_k)
);

-- Place names (D-193) from Kartverket's place-name register, for the map's
-- search: one row per name in use (a place may have several, sharing its
-- place_id), and each
-- name's word starts as keys (lower case), so a prefix finds any word. Loaded
-- whole by places.Load, which builds new tables and swaps them in; when it
-- ran is the table's comment. No node ids: it says nothing about the mesh.
CREATE TABLE IF NOT EXISTS place_name (
    id           INTEGER NOT NULL,
    place_id     INTEGER NOT NULL, -- Kartverket's stedsnummer: a place's names share it
    alt          BOOLEAN NOT NULL, -- not its main name (another language or spelling)
    name         TEXT NOT NULL,
    name_lc      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    rank         SMALLINT NOT NULL,
    importance   SMALLINT NOT NULL,
    municipality TEXT NOT NULL DEFAULT '',
    county       TEXT NOT NULL DEFAULT '',
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    CONSTRAINT place_name_pkey PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS place_key (
    key     TEXT COLLATE "C" NOT NULL, -- byte order, so LIKE 'abc%' uses the index
    name_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS place_key_key_idx ON place_key (key);

COMMENT ON TABLE packet_log IS 'meshmap-schema:5';
