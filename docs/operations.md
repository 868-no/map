# Operations

## Deploy

```sh
cp .env.example .env              # set POSTGRES_PASSWORD
mkdir -p secrets && cp config/examples/*.yaml secrets/   # edit brokers and channel keys
scripts/basemap_import.sh         # once; self-hosted basemap
docker compose run --rm backend check-config
docker compose up -d --build
```

The map is at `http://<host>:${WEB_PORT:-8080}`. Only the `web` service publishes a port.

### Published images

GitHub Actions (`.github/workflows/images.yml`) builds both images for every pull request and publishes them to GitHub Container Registry from `main` and from version tags, for `linux/amd64` and `linux/arm64`, with provenance and SBOM attestations:

| Image | Tags |
|---|---|
| `ghcr.io/868-no/map-backend` | `latest` and `main` (main branch), `X.Y.Z` and `X.Y` (tag `vX.Y.Z`), `sha-<commit>` |
| `ghcr.io/868-no/map-web` | same |

To run them instead of building locally, set `BACKEND_IMAGE` and `WEB_IMAGE` in `.env` (see `.env.example`), then:

```sh
docker compose pull backend web
docker compose up -d
```

Pin a version tag or `sha-…` in production. The web image is built without the end-to-end test hook.

## Configuration files

- `secrets/mqtt-brokers.yaml`: a list of brokers, each with `id`, `host`, `port`, `protocol` (v5/v311), `tls` (enabled, ca_file, server_name), `username`, `password` or `password_file`, `client_id` and `topics` (filter, qos 0/1). Set `accept_retained: false` (the default) so retained messages never fabricate current activity.
- `secrets/channel-keys.yaml`: a list of channels, each with `name`, `broker_ids` (`*` for all), `mode` (`ctr`, or `ccm` for firmware 2.8.1+ AEAD channels), `psks` (current key first, then previous keys during rotation; base64, or `hex:`; `AQ==` is the public default key) and `accept_plaintext` (default true for configured channels).
- Key rotation: add the new key first and keep the old one until no traffic uses it, then restart `backend`. The configuration hash is part of cache keys, so results recompute automatically.

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

Public by default. For basic auth, create `deploy/caddy-auth/basic.caddy` (see the README there) and restart `web`.

## Health and metrics

- `GET /health/live`: process up.
- `GET /health/ready`: database, schema version, Redis (degraded when unreachable; caching and dedupe fall back), ingest writer and queue, broker connection states, and the last retention run (time, deleted rows, table size).
- Prometheus metrics at `backend:9100/metrics` (compose network only), or on `/metrics` with `PUBLIC_METRICS_ENABLED=true`. Key series:
  - `meshmap_mqtt_received_total`, `meshmap_mqtt_connected`
  - `meshmap_ingest_accepted_total{packet_type,signature_status}`, `meshmap_ingest_rejected_total{category}` (includes `not_ok_to_mqtt_nodeinfo`: NodeInfo withheld because the sender did not allow MQTT uplink, and `map_report_invalid`)
  - `meshmap_ingest_dropped_total{reason}` (queue full = data loss window)
  - `meshmap_ingest_duplicate_deliveries_total{broker}`, `meshmap_ingest_provenance_updates_total`
  - `meshmap_writer_*`, `meshmap_identities`, `meshmap_retention_deleted_rows_total`

## Data loss windows

MQTT delivers Meshtastic traffic at QoS 0, so senders cannot be slowed. If PostgreSQL is unavailable, the writer retries with backoff while the bounded queue (`INGEST_QUEUE_SIZE`, default 20 000 messages, several minutes at 100 msg/s) absorbs input. Beyond that, messages are dropped and counted (`reason="queue_full"`). Broker disconnections lose whatever the broker does not retain. The map shows what this service observed, not complete history.

## Retention

The `maintenance` service deletes rows older than `RETENTION_MONTHS` (default 6 calendar months, clamped at month ends) daily at 03:00 UTC, and at startup if a run is overdue. It deletes in 5 000-row transactions under a PostgreSQL advisory lock, then runs `VACUUM (ANALYZE)`, bumps the retention revision (invalidating cached results) and notifies open browser sessions. Run it manually with `docker compose run --rm maintenance maintenance --once`.

## Backup and restore

```sh
docker compose exec -T postgres pg_dump -U meshmap -Fc meshmap > meshmap-$(date +%F).dump
docker compose exec -T postgres pg_restore -U meshmap -d meshmap --clean --if-exists < meshmap-YYYY-MM-DD.dump
```

Only `packet_log` matters; Redis is ephemeral and rebuilds itself. After a restore, restart `backend` so the identity index rebuilds.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Map is grey/empty | `data/basemap/basemap.pmtiles` exists; `curl -r 0-99 localhost:8080/tiles/basemap.pmtiles` returns 206 |
| No nodes | `/health/ready` broker states; rejection metrics (`no_key` → missing channel key; `retained_ignored`; `topic_json`) |
| Many `decrypt_failed` | Wrong PSK for that channel name, or a CCM channel configured as `ctr` |
| `sig_invalid` rejections | Forged or corrupted signed packets; expected to be rare on real traffic |
| Live badge “paused” | Redis down in API-only mode, or SSE blocked by a proxy (disable buffering) |
| Inspect real traffic | `docker run --rm eclipse-mosquitto:2 mosquitto_sub -h HOST -u U -P P -t 'msh/#' -F '%U\|%r\|%t\|%x' -W 600 > cap.txt` then `scripts/go.sh go run ./cmd/meshmap inspect cap.txt` |

## Production security checklist

- [ ] Strong `POSTGRES_PASSWORD`; `.env` and `secrets/` readable only by the deploy user; neither is in Git.
- [ ] TLS in front of `web`; HSTS at the TLS proxy.
- [ ] `PUBLIC_METRICS_ENABLED=false` unless metrics are protected.
- [ ] Brokers use TLS where available; `accept_retained: false`.
- [ ] `SIGNATURE_POLICY=strict` if unverifiable signed packets should be dropped.
- [ ] `GEOLOCATION_EXCLUDE_NODE_IDS` lists nodes whose owners opted out of location estimates.
- [ ] Backups scheduled; restore tested.
