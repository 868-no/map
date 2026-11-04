# Operations

How to deploy, configure and run the 868.no Map. For what the system does and why, see [design.md](design.md).

## Deploy

```sh
cp .env.example .env              # set POSTGRES_PASSWORD
mkdir -p secrets && cp config/examples/*.yaml secrets/   # edit brokers and channel keys
docker compose run --rm backend check-config
docker compose up -d --build
```

The map is at `http://<host>:${WEB_PORT:-8080}`. Only the `web` service publishes a port. On first start the `basemap` service builds the self-hosted basemap (see [basemap.md](basemap.md)); until it is ready the map works without one.

### Everything in one Compose file

[`deploy/compose.production.yaml`](../deploy/compose.production.yaml) runs the published images with all configuration in the Compose file: no `.env`, no `./secrets`. Broker and channel configuration go in the `MQTT_BROKERS` and `CHANNEL_KEYS` environment variables, as the same YAML as the files (when set, they replace `MQTT_BROKERS_CONFIG` and `CHANNEL_KEYS_CONFIG`). Secrets are written as `${POSTGRES_PASSWORD}`, `${MQTT_USERNAME}` and `${MQTT_PASSWORD}` and filled in from the stack's environment. Check it with:

```sh
docker compose -f deploy/compose.production.yaml run --rm backend check-config
```

Env values are visible to anyone who can run `docker inspect` on the host; use the file-based configuration if that matters.

### Continuous integration

`.github/workflows/tests.yml` runs on every pull request and push: Go vet, gofmt and unit tests; the integration tests (throwaway Postgres, Redis and Mosquitto); the engine's Rust tests (including the golden fixture); the frontend's type check, lint, unit tests and production build; and the end-to-end tests (Playwright, in four parallel shards, each against its own demo stack: the simulated mesh on a local broker plus two days of seeded history). It uses the same Docker-wrapped toolchains as local development (`scripts/*.sh`). The basemap is not built in CI, so end-to-end tests that need real map labels skip themselves there; run them against a full deployment.

The `deploy` job runs on pushes to `main` only, after the images job has published the images: it calls the production Portainer stack's webhook, which pulls them and recreates the stack, one deploy at a time in push order. The webhook URL is its only credential, kept in the `DEPLOY_WEBHOOK_URL` repository secret; without it the job fails and nothing is deployed.

### Published images

GitHub Actions (`.github/workflows/images.yml`, called by the tests workflow once every test job, end-to-end included, has passed) builds the three images for every pull request and publishes them to GitHub Container Registry from `main` and from version tags, so nothing untested is published, for `linux/amd64` and `linux/arm64`, with provenance and SBOM attestations:

| Image | Tags |
|---|---|
| `ghcr.io/868-no/map-backend` | `main` (main branch), `X.Y.Z` and `X.Y` (tag `vX.Y.Z`), `latest` (whichever was published last: `main` or a version tag other than a pre-release), `sha-<commit>` |
| `ghcr.io/868-no/map-web` | same |
| `ghcr.io/868-no/map-basemap` | same |

To run them instead of building locally, set `BACKEND_IMAGE`, `WEB_IMAGE` and `BASEMAP_IMAGE` in `.env` (see `.env.example`), then:

```sh
docker compose pull backend web basemap
docker compose up -d
```

Pin a version tag or `sha-…` in production (`compose.production.yaml` takes it from `MESHMAP_TAG`, default `latest`). The web image is built without the end-to-end test hook.

## Configuration files

- `secrets/mqtt-brokers.yaml`: a list of brokers, each with `id`, `host`, `port`, `protocol` (v5/v311), `tls` (enabled, ca_file, server_name), `username`, `password` or `password_file`, `client_id` and `topics` (filter, qos 0/1). Set `accept_retained: false` (the default) so retained messages never fabricate current activity.
- `secrets/channel-keys.yaml`: a list of channels, each with `name`, `broker_ids` (`*` for all), `mode` (`ctr`, or `ccm` for firmware 2.8.1+ AEAD channels), `psks` (current key first, then previous keys during rotation; base64, or `hex:`; `AQ==` is the public default key) and `accept_plaintext` (default true for configured channels). List as many channels as you like; a channel name may also appear more than once with different `broker_ids`.
- Channels that are not listed are tried with the public default key (`AQ==`, CTR and CCM) under the channel name in the topic, so default-key channels with any name decode without configuration (D-065). The packet's channel byte (a hash of name and key) must match, so channels with their own key stay undecoded: they are stored header-only as `encrypted` rows (D-093). Set `DEFAULT_KEY_FALLBACK=false` to decode only listed channels.
- Key rotation: add the new key first and keep the old one until no traffic uses it, then restart `backend`. The configuration hash is part of the `generation` that `/observations` reports, so browsers discard the rows they hold and refetch.
- Optional: `GEOLOCATION_CALIBRATION` is the path to a YAML file with `default: {p0_dbm, path_loss_exponent}` for calibrated RF location estimates (D-016). All other settings are environment variables; see `.env.example` and `backend/internal/config/config.go`.

## Privacy policy

The map links to `/privacy.html` (source: `frontend/public/privacy.html`). It describes what this software collects and fills in, from `/api/v1/capabilities`, the operator (`OPERATOR_NAME`), how to reach them (`OPERATOR_CONTACT`, an e-mail address or URL), the retention period, whether position estimates are on, whether map tiles come from an outside provider and whether the backend fetches weather from MET Norway (`WEATHER_ENABLED`, on by default; it needs outbound HTTPS to `thredds.met.no`, D-133). Set both operator variables in production. If you change what the deployment collects or shares (an outside tile provider, access logs in your reverse proxy), check the page still matches, and edit it if not; it is a draft for the operator to review, not legal advice.

## HTTPS / reverse proxy

Terminate TLS in front of `web`, for example with Caddy:

```caddyfile
map.example.org {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1   # SSE
    }
}
```

or with nginx: `proxy_buffering off; proxy_read_timeout 1h;` on `location /api/v1/stream`.

Serve the map over HTTPS: browsers only enable the service worker (offline use) and "install app" on secure origins (`localhost` is exempt for development).

`web` honours `X-Forwarded-For` only from private-range peers. The backend trusts `TRUSTED_PROXIES` (default: private ranges), so per-client rate limits see real client addresses.

## Access control

Public by default. For basic auth, create `deploy/caddy-auth/basic.caddy` (see the README there) and restart `web`. `compose.production.yaml` does not mount that directory; add a volume for `/etc/caddy/auth` to `web` there if you need it.

## Health and metrics

- `GET /health/live`: process up.
- `GET /health/ready`: database, schema version, Redis (degraded when unreachable; dedupe falls back to a database lookup), ingest writer and queue, broker connection states, and the last retention run (time, deleted rows, table size).
- Prometheus metrics at `backend:9100/metrics` (compose network only). `PUBLIC_METRICS_ENABLED=true` also serves them on the backend's HTTP port (`backend:8000/metrics`); the `web` service does not proxy that path, so publishing them needs your own reverse-proxy route (protect it). Key series:
  - `meshmap_mqtt_received_total`, `meshmap_mqtt_connected`
  - `meshmap_ingest_accepted_total{packet_type,signature_status}`, `meshmap_ingest_rejected_total{category}` (duplicates, unparseable envelopes and `map_report_invalid`; packets that fail keys, decoding or verification are accepted as `encrypted`/`invalid` header-only rows)
  - `meshmap_ingest_dropped_total{reason}` (queue full = data loss window)
  - `meshmap_ingest_duplicate_deliveries_total{broker}`, `meshmap_ingest_provenance_updates_total`
  - `meshmap_writer_*`, `meshmap_identities`, `meshmap_retention_deleted_rows_total`

## Data loss windows

MQTT delivers Meshtastic traffic at QoS 0, so senders cannot be slowed. If PostgreSQL is unavailable, the writer retries with backoff while the bounded queue (`INGEST_QUEUE_SIZE`, default 20 000 messages, several minutes at 100 msg/s) absorbs input. Beyond that, messages are dropped and counted (`reason="queue_full"`). Broker disconnections lose whatever the broker does not retain. The map shows what this service observed, not complete history.

## Upgrading to schema 2 (monthly partitions)

The first start of a version with D-056 converts `packet_log` to a partitioned table, in one transaction under the schema lock: the old table is copied with its ids and dropped, and `/health/ready` reports `meshmap-schema:2` afterwards. It needs free disk space for a second copy of the table while it runs, and takes roughly as long as copying the table (the dev database's 17 000 rows took under a second; plan for minutes per few million rows). Take a backup first (see below). Older binaries cannot start against schema 2; to roll back, restore the backup.

## Upgrading to schema 3 (weather)

Schema 3 adds the `weather_hour` table (D-133); `init-schema` creates it at the first start of a version that has it, with nothing to convert. The backend checks the exact schema version and list of tables at startup, so an image older than schema 3 refuses to start against a schema-3 database. To roll back past it, restore a backup taken before the upgrade.

## Retention

`packet_log` is partitioned by calendar month (D-056). The `maintenance` service removes rows older than `RETENTION_MONTHS` (default 6 calendar months, clamped at month ends) daily at 03:00 UTC, and at startup if a run is overdue. Under a PostgreSQL advisory lock it drops the partitions of months that end before the cutoff, deletes the remaining expired rows of the cutoff's month in 5 000-row transactions, runs `VACUUM (ANALYZE)` on that partition only, creates partitions for the next two months, stores the run's status (shown in `/health/ready`) and notifies open browser sessions. Run it manually with `docker compose run --rm maintenance maintenance --once`.

## Importing history from Meshstellar

`meshmap import-envelopes` loads MQTT history recorded by another collector into `packet_log` through the same ingest code as live traffic: the same decoding, channel keys, signature checks and privacy stripping (D-137). [Meshstellar](https://github.com/jurriaan/meshstellar) keeps every raw MQTT payload it received, with its receive time, in the `service_envelopes` table of its SQLite database, so its history can be replayed:

```sh
# 1. Dry run: decode everything and print counts; nothing is written.
sqlite3 -readonly -csv meshstellar.db \
  "SELECT created_at, hex(payload_data) FROM service_envelopes ORDER BY created_at" |
  docker exec -i <backend container> meshmap import-envelopes --broker no868 --dry-run

# 2. The import itself: the same without --dry-run. Safe to re-run after an interruption.
# 3. Restart the backend so the identity index and trends include the imported history.
```

- **`--broker`** names the configured broker the history came from: its channel keys and plaintext rules decide how envelopes decode, and imported rows carry its id.
- **What is imported:** envelopes received after the retention cutoff (`RETENTION_MONTHS`; raise it first to keep more) and before the broker's first stored row, since the two collectors received the same uploads at slightly different times and those would otherwise be stored twice. `--after` and `--before` (RFC 3339) narrow or move the span.
- **Topics:** Meshstellar stores the payload but not the topic, so the topic is rebuilt from the envelope (`<root>/2/e/<channel>/<gateway>`, or `<root>/2/map/` for map reports). The root is each gateway's own, from its live rows where it has any, else the broker's subscription without `/#` (or `--topic-root`).
- **Duplicates:** the same upload delivered twice within 15 minutes is stored once, as at ingest; JSON and status messages are skipped.
- **Browsers:** a browser that already holds a copy of a window reaching back before the broker's first row (within its last 8 days) keeps its empty copy of that span until it falls out of the window, or until Settings → Reset.

## Backup and restore

Not automated: schedule the dump below (e.g. with cron) if the history matters to you. Without backups, losing the database volume loses the history; the map refills from live traffic.

```sh
docker compose exec -T postgres pg_dump -U meshmap -Fc meshmap > meshmap-$(date +%F).dump
docker compose exec -T postgres pg_restore -U meshmap -d meshmap --clean --if-exists < meshmap-YYYY-MM-DD.dump
```

Only `packet_log` matters; Redis is ephemeral and rebuilds itself. After a restore, restart `backend` so the identity index rebuilds; it also rebuilds any missing or outdated stored row encodings in the background (D-046).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Map is grey/empty | `docker compose logs basemap` (the first build takes a while); `data/basemap/basemap.pmtiles` (or the `basemap` volume with `compose.production.yaml`) exists; `curl -r 0-99 localhost:8080/tiles/basemap.pmtiles` returns 206 |
| No nodes | `/health/ready` broker states; rejection metrics (`retained_ignored`; `topic_json`) and accepted `encrypted` rows (no listed key and not the default key) |
| Many `encrypted` rows on a listed channel | `meshmap_ingest_accepted_total{packet_type="encrypted"}`: packets that no key decrypts are kept header-only as `encrypted`. Wrong PSK for that channel name, or a CCM channel configured as `ctr` |
| Many `invalid` rows | `meshmap_ingest_accepted_total{packet_type="invalid"}`; the row's `iv` field (in the sender's packet log) names the reason. `iv=sig_invalid`: forged or corrupted signed packets, expected to be rare on real traffic |
| Live badge “paused” | Redis down in API-only mode (`serve --no-ingest`), or SSE blocked by a proxy (disable buffering) |
| Inspect real traffic | `docker run --rm eclipse-mosquitto:2 mosquitto_sub -h HOST -u U -P P -t 'msh/#' -F '%U\|%r\|%t\|%x' -W 600 > cap.txt` then `scripts/go.sh go run ./cmd/meshmap inspect cap.txt` |

## Production security checklist

- [ ] Strong `POSTGRES_PASSWORD`; `.env` and `secrets/` readable only by the deploy user; neither is in Git.
- [ ] TLS in front of `web`; HSTS at the TLS proxy.
- [ ] `PUBLIC_METRICS_ENABLED=false` unless metrics are protected.
- [ ] Brokers use TLS where available; `accept_retained: false`.
- [ ] `SIGNATURE_POLICY=strict` if signed packets from unknown keys should be kept header-only as `invalid` (`iv=strict_unverifiable`) instead of `unverifiable`.
- [ ] `GEOLOCATION_EXCLUDE_NODE_IDS` lists nodes whose owners opted out of location estimates.
- [ ] Backups scheduled; restore tested.
