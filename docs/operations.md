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

`.github/workflows/tests.yml` runs on every pull request and push: Go vet, gofmt and unit tests; the integration tests (throwaway Postgres, Redis and Mosquitto); the engine's Rust tests (including the golden fixture); the frontend's type check, lint, unit tests and production build; and the end-to-end tests (Playwright, in four parallel shards, each against its own demo stack: the simulated mesh on a local broker plus two days of seeded history). It uses the same Docker-wrapped toolchains as local development (`scripts/*.sh`). Their caches (Go's build and module caches, npm's, Cargo's registry and target directory with wasm-bindgen, and wasm-opt) live in Docker volumes, or with `MESHMAP_CACHE` set in directories under it: on GitHub-hosted runners `.github/actions/toolchain-cache` sets it and saves those directories with `actions/cache`, one cache per job, keyed by its lock files and scripts and restored from the job's previous cache when they change. Self-hosted runners keep the volumes instead and skip it. GitHub keeps 10 GB of caches per repository, evicting the least recently used; the image builds' layer caches share that space. The basemap is not built in CI, so end-to-end tests that need real map labels skip themselves there; run them against a full deployment.

The `deploy` job runs on pushes to `main` only, after the images job has published the images: it calls the production Portainer stack's webhook, which pulls them and recreates the stack, one deploy at a time in push order. The webhook URL is its only credential, kept in the `DEPLOY_WEBHOOK_URL` repository secret; without it the job fails and nothing is deployed.

### Self-hosted runners

The test and image jobs run on GitHub-hosted runners unless the repository variable `RUNNER_LABELS` (Settings → Secrets and variables → Actions → Variables) names self-hosted ones as a JSON list, e.g. `["self-hosted","meshmap"]`. Even then, only runs on `main` (pushes and manual runs) take them; **pull requests always run on GitHub's**: the repository is public, and a pull request from a fork runs its own code, which must never reach a machine of ours. So do tags, other branches and the `deploy` job. With no self-hosted runner online, runs on `main` queue; clearing the variable sends them back to GitHub's.

The workflow files alone cannot guarantee that: a pull request runs the workflow as it changed it, so one could ask for the self-hosted labels. The runners enforce it themselves: their job-started hook, which runs before any step and which no workflow can skip, fails every job that is not a `push` or `workflow_dispatch` on `refs/heads/main` with its workflow file from `main` (`GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_WORKFLOW_REF`). Also set Settings → Actions → General → "Approval for running fork pull request workflows" to all external contributors, so no fork's workflow runs anywhere before someone has read it.

`deploy/runners/compose.yaml` runs four just-in-time runners, each with a Docker daemon of its own (Docker-in-Docker) whose network namespace it shares:

- **The token stays out of the runners.** Only the `controller` service holds `ACCESS_TOKEN`. For each slot it asks GitHub for a single-use runner configuration (`generate-jitconfig`) and writes it to a volume shared with that slot's runner alone; the runner deletes it, runs one job and exits, and GitHub removes it. The controller issues the slot's next configuration only once that runner is gone, so a job never sees the next one, and never the token: a job runs as root in its runner and could read anything given to the runner's processes. A runner that took its configuration but stayed offline for 3 minutes is deleted and replaced, and at start the controller removes idle offline runners of its prefix left from before. The controller needs no Docker socket and listens on nothing.

- Jobs start containers as on a hosted runner: their published ports are on the runner's `localhost` (the end-to-end stack on 8080, Playwright's `--network host`), and parallel jobs never collide on ports, container names or networks.
- The work directory is mounted at the same path (`/_work`) in the runner and its daemon, so `docker run -v "$repo":/src` in `scripts/*.sh` finds the checkout.
- Each daemon keeps its state on a volume of its own (pulled images, the build cache), and the toolchains' caches are on one volume, `toolchains`, that every runner and daemon mounts at `/_cache` (`MESHMAP_CACHE`, as `scripts/*.sh` read it: Go's build and module caches, npm's, Cargo's registry and target directory with wasm-bindgen, wasm-opt). A job finds them warm on whichever slot it lands on; Go, npm and Cargo all take concurrent jobs (Cargo makes one wait for the other's build). All stay warm between jobs, while each runner is registered afresh for every job. Before each job, after that check, the hook (inline in `compose.yaml`, run by the runner with bash) removes leftover containers, networks, anonymous volumes and untagged images, and trims the build cache to 20 GB, least recently used first. Tagged images and the cache volumes are kept; to start a runner from cold, remove its `docker-N` volume.
- Only the daemons are privileged; the runners are not, and the daemons listen on a socket shared with their runner alone, not on TCP.

To set it up on a dedicated host (a VM, not one with access to production or other secrets: a job, and so anyone who can push to `main`, controls the daemon):

```sh
cd deploy/runners
cp .env.example .env   # ACCESS_TOKEN: a fine-grained token for this repository only, "Administration: Read and write", with an expiry
docker compose up -d
```

The stack is `compose.yaml` alone, so it also runs as a Portainer stack from this repository: Add stack → Repository, the repository URL, reference `refs/heads/main`, compose path `deploy/runners/compose.yaml`, and the variables of `.env.example` (at least `ACCESS_TOKEN`) under Environment variables. With automatic updates on, Portainer redeploys it when the file changes on `main`, such as a bumped runner image.

**AppArmor on the host.** Jobs' containers run in Docker-in-Docker without Docker's own AppArmor profile, so a profile the host attaches to a program by its path applies to that program in them too. Recent Ubuntu releases ship such profiles for many programs: the one for `mosquitto` only lets it read its config under `/etc/mosquitto`, so the integration and end-to-end tests' broker failed with "Unable to open config file" (`dmesg` shows `apparmor="DENIED" … profile="mosquitto"`). Disable such a profile on the runner host, which runs none of those programs itself:

```sh
f=$(grep -l '^profile mosquitto' /etc/apparmor.d/*); sudo ln -s "$f" /etc/apparmor.d/disable/ && sudo apparmor_parser -R "$f"
```

The runners appear under Settings → Actions → Runners as `meshmap-N-<time>`, one per slot waiting for a job (`RUNNER_NAME_PREFIX` per host); `docker compose logs controller` says what it issued and any API errors. Then set `RUNNER_LABELS`. Bump the runner image in `compose.yaml` at least monthly: GitHub refuses runners that are too far behind, and a runner a little behind updates itself first, at every job, since each starts from the image. Multi-platform images still build arm64 under QEMU unless the host is arm64.

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

- `secrets/mqtt-brokers.yaml`: a list of brokers, each with `id`, `host`, `port`, `protocol` (v5/v311), `tls` (enabled, ca_file, server_name, insecure_skip_verify), `username`, `password` or `password_file`, `client_id` and `topics` (filter, qos 0/1). Set `accept_retained: false` (the default) so retained messages never fabricate current activity. Prefer `v5` on public brokers: it asks the broker (CONNECT Maximum Packet Size, 8 KiB) to discard larger publishes before they reach the backend. MQTT 3.1.1 has no equivalent, so with `v311` the client reads every packet whole (a hostile publisher can send up to the broker's own limit, which MQTT allows to be 256 MiB) before the 4 KiB payload limit drops it; cap `max_packet_size` on brokers you run yourself.
- `secrets/channel-keys.yaml`: a list of channels, each with `name`, `broker_ids` (`*` for all), `mode` (`ctr`, or `ccm` for firmware 2.8.1+ AEAD channels), `psks` (current key first, then previous keys during rotation; base64, or `hex:`; `AQ==` is the public default key) and `accept_plaintext` (default true for configured channels). List as many channels as you like; a channel name may also appear more than once with different `broker_ids`.
- Channels that are not listed are tried with the public default key (`AQ==`, CTR and CCM) under the channel name in the topic, so default-key channels with any name decode without configuration (D-065). The packet's channel byte (a hash of name and key) must match, so channels with their own key stay undecoded: they are stored header-only as `encrypted` rows (D-093). Set `DEFAULT_KEY_FALLBACK=false` to decode only listed channels.
- Key rotation: add the new key first and keep the old one until no traffic uses it, then restart `backend`. The configuration hash is part of the `generation` that `/observations` reports, so browsers discard the rows they hold and refetch.
- Optional: `GEOLOCATION_CALIBRATION` is the path to a YAML file with `default: {p0_dbm, path_loss_exponent}` for calibrated RF location estimates (D-016). All other settings are environment variables; see `.env.example` and `backend/internal/config/config.go`.

## Privacy policy

The map links to `/privacy.html` (source: `frontend/public/privacy.html`). It describes what this software collects and fills in, from `/api/v1/capabilities`, the operator (`OPERATOR_NAME`), how to reach them (`OPERATOR_CONTACT`, an e-mail address or URL; with weather on, it is also sent to MET Norway in the backend's User-Agent), the retention period, whether position estimates are on, whether map tiles come from an outside provider and whether the backend fetches weather from MET Norway (`WEATHER_ENABLED`, on by default; it needs outbound HTTPS to `thredds.met.no`, D-133) and whether it fetches terrain heights from Kartverket (`TERRAIN_ENABLED`, on by default; it needs outbound HTTPS to `ws.geonorge.no`, and sends the operator contact in its User-Agent too, D-143; from start it also warms heights between infrastructure nodes in the background so cross sections are ready before visitors ask, D-144). Set both operator variables in production. If you change what the deployment collects or shares (an outside tile provider, access logs in your reverse proxy), check the page still matches, and edit it if not; it is a draft for the operator to review, not legal advice.

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

So `web` must not be reachable from the internet except through the proxy or tunnel: anyone who reaches it from a private address can set `X-Forwarded-For` and pick their own rate-limit bucket. Under Swarm, a port published through the ingress routing mesh is worse: every client arrives from a `10.0.x.x` ingress address, so all visitors share one rate-limit bucket, and anyone reaching that port can set `X-Forwarded-For`. Prefer an overlay network with no published port (as with a Cloudflare tunnel), or publish in `mode: host` behind a firewall that admits only the proxy (D-167).

## Caching at Cloudflare

Whole past days of rows (`/api/v1/observations/day/{date}?generation=…`, D-158) are the same for every visitor and, once final, answered `Cache-Control: public, max-age=31536000, immutable`; anything not final is `no-store`. Cloudflare does not cache JSON from extensionless paths by default, so add a Cache Rule (Caching → Cache Rules):

- **When:** URI Path starts with `/api/v1/observations/day/`.
- **Then:** Eligible for cache; Edge TTL "Use cache-control header if present, bypass cache if not"; Browser TTL "Respect origin"; keep the default cache key, which includes the query string (the generation).

Every new visitor then reads past days from Cloudflare, and the backend reads each day from Postgres once per generation (Redis shares that read between replicas). A generation change (deploy with a decoder or row-format change, configuration change, history import) changes the URLs, so nothing needs purging. `/api/v1/trends` (`max-age=900, stale-while-revalidate=3600`: the same few URLs for every visitor) is worth adding to the same rule (**Or** URI Path starts with `/api/v1/trends`); leave `/api/v1/observations` and the live stream out (they are `no-store` and per visitor anyway). `meshmap_api_day_requests_total{result}` shows how days reaching the backend are answered (`hit` from Redis, `built` from Postgres, `uncached` not final yet, `large` streamed because an earlier build outgrew 64 MB, `not_modified`). Cached days (a gzip and a brotli copy, up to 16 MB each; a 6 MB day of rows is about 0.8 MB gzipped and 0.6 MB as brotli, which Cloudflare passes to browsers that accept it, D-168) share Redis with ingest's dedupe keys under `allkeys-lru`, so Redis runs with `--maxmemory 512mb` (`REDIS_MAXMEMORY` in the development compose file); raise it if `meshmap_api_day_requests_total{result="built"}` keeps climbing for days already served (D-166).

## Scaling horizontally (Swarm)

[`deploy/stack.swarm.yaml`](../deploy/stack.swarm.yaml) is `compose.production.yaml` split for Docker Swarm (`docker stack deploy -c deploy/stack.swarm.yaml meshmap`, or a Portainer stack) so the HTTP API can run as several replicas (D-157):

| Service | Command | Replicas | Why |
| --- | --- | --- | --- |
| `ingest` | `serve` | exactly 1, `stop-first` | MQTT ingest: the broker `client_id` is fixed, so two would disconnect each other, and two subscribers would only duplicate work. It is also the only process that fetches weather (MET's MEPS archive answers 429 to a second concurrent request) and terrain (Geonorge should see one client), runs their warmers, and knows broker state for `/health/ready`. |
| `backend` | `serve --no-ingest` | `API_REPLICAS` (default 2), `start-first` | The API. `WEATHER_ENABLED=false`, `TERRAIN_ENABLED=false`; live rows arrive over Redis pub/sub, so Redis is required. Page cursors are stateless, so any replica answers any page. |
| `web` | Caddy | 2 | Stateless. |
| `postgres`, `redis`, `maintenance`, `basemap` | | 1 each | `maintenance` takes an advisory lock anyway; Postgres is `stop-first` so two servers never share the data directory. |

**Routing.** `web/Caddyfile` reads two upstreams from the environment: `FETCH_UPSTREAM` gets `/api/v1/weather`, `/api/v1/terrain` and `/api/v1/terrain/*`, `/api/v1/capabilities` (a replica with weather and terrain off would report them off) and `/health/*`; `API_UPSTREAM` gets the rest of `/api/*`, the live stream included (flushed for SSE). Both default to `backend:8000`, so a single `serve` (the dev `compose.yaml`, CI, `compose.production.yaml`) behaves as before. The stack sets `API_UPSTREAM=backend:8000` and `FETCH_UPSTREAM=ingest:8000`; Swarm's service address spreads connections over the replicas.

**Volumes.** A named volume in Swarm lives on whichever node the task runs on. `pgdata` must follow `postgres`, and `basemap` is written by `basemap` and read by every `web` replica, so the stack declares both as NFS volumes (`NFS_SERVER`, `NFS_PGDATA_PATH`, `NFS_BASEMAP_PATH`); alternatively pin those services to one node with placement constraints. NFS caveats: Postgres's entrypoint chowns its data directory, so the `pgdata` export needs `no_root_squash` or the directory owned beforehand by uid/gid 70 (`postgres` in `postgres:16-alpine`). Docker never updates a named volume's `driver_opts` once it exists on a node, so to change the server or path remove the volume on every node (`docker volume rm meshmap_pgdata`) before redeploying. Planetiler's temporary files (several GB during a build) and downloads go to the `basemap` volume, so the export needs room for them (see [basemap.md](basemap.md)). Swarm ignores `restart:` and `depends_on:`: the stack uses `deploy.restart_policy`, and the backend waits for the database by itself.

**Edge.** The stack publishes `web` on port 8080 through the ingress mesh. To reach it from a tunnel or proxy container on an existing overlay network instead, drop `ports` and attach `web` to that network (the commented `edge` network in the file). Prefer that: through the ingress mesh every client looks like the same `10.0.x.x` address (see [HTTPS / reverse proxy](#https--reverse-proxy)); otherwise publish in `mode: host` behind a firewall.

**Connection budget.** Postgres is the shared limit. The ingest process opens `DB_API_CONNS + DB_INGEST_CONNS` (default 12 + 6 = 18), each API replica only `DB_API_CONNS` (12), maintenance 2. With the default `max_connections=100` (3 reserved for superusers), 18 + 2 + 12 × (replicas + 1 for the extra task during a `start-first` update) must stay under 97: at most 5 replicas at the defaults. For more, lower `DB_API_CONNS` (keeping `API_READ_SLOTS ≤ DB_API_CONNS − 2`) or raise `max_connections` (each connection costs Postgres memory). More replicas add HTTP and encoding capacity, not database capacity: the `/observations` reads run in Postgres.

**Limits become per replica.** Every per-visitor limit is kept in process memory: the request rate (`API_RATE_PER_SECOND`, `API_RATE_BURST`), live streams (`API_STREAMS_PER_CLIENT`, `API_STREAMS_TOTAL`), `/observations` read slots (`API_READS_PER_CLIENT`, `API_READ_SLOTS`) and the weather and terrain turns. With N replicas a visitor whose connections land on different replicas gets up to N times as much; weather and terrain turns stay single because one process serves them. Lower the per-client values if that matters.

**Other per-process work.** Each replica runs at start the stored-row-encoding backfill (`FOR UPDATE SKIP LOCKED`, so replicas share the work rather than repeat it) and `InitSchema` (serialised by an advisory lock). Trend summaries are kept per process, so each replica scans the log once on its first `/trends` request after a start and refreshes on its own; the identity index lives only in `ingest`, so restart `ingest` (not the replicas) after an import or restore. Metrics on `:9100` are per task.

## Access control

Public by default. For basic auth, create `deploy/caddy-auth/basic.caddy` (see the README there) and restart `web`. `compose.production.yaml` does not mount that directory; add a volume for `/etc/caddy/auth` to `web` there if you need it.

## Health and metrics

- `GET /health/live`: process up. The container health checks probe this (`meshmap healthcheck --live`), not readiness; see "Data loss windows" (D-163).
- `GET /health/ready`: database, schema version, Redis (degraded when unreachable; dedupe falls back to a database lookup and leaves Redis alone for 30 s after an error, D-166), ingest writer and queue, broker connection states, and the last retention run (time, deleted rows, table size).
- Prometheus metrics at `backend:9100/metrics` (compose network only). `PUBLIC_METRICS_ENABLED=true` also serves them on the backend's HTTP port (`backend:8000/metrics`); the `web` service does not proxy that path, so publishing them needs your own reverse-proxy route (protect it). Key series:
  - `meshmap_mqtt_received_total`, `meshmap_mqtt_connected`
  - `meshmap_ingest_accepted_total{packet_type,signature_status}`, `meshmap_ingest_rejected_total{category}` (duplicates, unparseable envelopes and topics, `oversize`, `map_report_invalid` and `db_refused_row`, rows the database refused as data errors (SQLSTATE class 22/23), dropped instead of stalling the writer; packets that fail keys, decoding or verification are accepted as `encrypted`/`invalid` header-only rows)
  - `meshmap_ingest_dropped_total{reason}` (queue full = data loss window)
  - `meshmap_ingest_duplicate_deliveries_total{broker}`, `meshmap_ingest_provenance_updates_total`
  - `meshmap_writer_*`, `meshmap_identities` (retention's deleted rows are in `/health/ready`, from the maintenance process)
  - `meshmap_api_day_requests_total{result}` (whole days, D-158), `meshmap_cache_errors_total{op}`

## Data loss windows

MQTT delivers Meshtastic traffic at QoS 0, so senders cannot be slowed. If PostgreSQL is unavailable, the writer retries with backoff while the bounded queue (`INGEST_QUEUE_SIZE`, default 20 000 messages, several minutes at 100 msg/s) absorbs input. Beyond that, messages are dropped and counted (`reason="queue_full"`). The queue lives in the process, so the backend's container health check probes `/health/live`, not `/health/ready` (which answers 503 while the database is unreachable): Swarm replaces a task that turns unhealthy, and a readiness check would kill `ingest` and its queue about a minute into an outage, its replacement then waiting for the database without ingesting. The API replicas use the same liveness check, since replacing them during an outage only churns and Swarm does not route by health (D-163). Broker disconnections lose whatever the broker does not retain. The map shows what this service observed, not complete history.

## Upgrading to schema 2 (monthly partitions)

The first start of a version with D-056 converts `packet_log` to a partitioned table, in one transaction under the schema lock: the old table is copied with its ids and dropped, and `/health/ready` reports `meshmap-schema:2` afterwards. It needs free disk space for a second copy of the table while it runs, and takes roughly as long as copying the table (the dev database's 17 000 rows took under a second; plan for minutes per few million rows). Take a backup first (see below). Older binaries cannot start against schema 2; to roll back, restore the backup.

## Upgrading to schema 3 (weather)

Schema 3 adds the `weather_hour` table (D-133); `init-schema` creates it at the first start of a version that has it, with nothing to convert. The backend checks the exact schema version and list of tables at startup, so an image older than schema 3 refuses to start against a schema-3 database. To roll back past it, restore a backup taken before the upgrade.

## Upgrading to schema 4 (terrain)

Schema 4 adds the `terrain_height` table (D-143); `init-schema` creates it at the first start of a version that has it, with nothing to convert. As with schema 3, an older image refuses to start against a schema-4 database; to roll back past it, restore a backup taken before the upgrade.

## Retention

`packet_log` is partitioned by calendar month (D-056). The `maintenance` service removes rows older than `RETENTION_MONTHS` (default 6 calendar months, clamped at month ends) on the schedule `MAINTENANCE_INTERVAL_HOURS` sets: 24 (the default) means daily at 03:00 UTC, any other value every that many hours. It also runs at startup if a run is overdue, and retries a failed run after 5 minutes. Under a PostgreSQL advisory lock it drops the partitions of months that end before the cutoff, deletes the remaining expired rows of the cutoff's month in 5 000-row transactions, runs `VACUUM (ANALYZE)` on that partition only, deletes `weather_hour` rows from before the cutoff, creates partitions for the next two months, stores the run's status (shown in `/health/ready`) and notifies open browser sessions. Run it manually with `docker compose run --rm maintenance maintenance --once`.

## Importing history from Meshstellar

`meshmap import-envelopes` loads MQTT history recorded by another collector into `packet_log` through the same ingest code as live traffic: the same decoding, channel keys, signature checks and privacy stripping (D-137). [Meshstellar](https://github.com/jurriaan/meshstellar) keeps every raw MQTT payload it received, with its receive time, in the `service_envelopes` table of its SQLite database, so its history can be replayed:

```sh
# 1. Dry run: decode everything and print counts; nothing is written.
sqlite3 -readonly -csv meshstellar.db \
  "SELECT created_at, hex(payload_data) FROM service_envelopes ORDER BY created_at" |
  docker exec -i <backend container> meshmap import-envelopes --broker no868 --dry-run

# 2. The import itself: the same without --dry-run. Safe to re-run after an interruption.
# 3. Restart the backend so the identity index includes the imported history (trends pick it up by themselves).
```

- **`--broker`** names the configured broker the history came from: its channel keys and plaintext rules decide how envelopes decode, and imported rows carry its id.
- **What is imported:** envelopes received after the retention cutoff (`RETENTION_MONTHS`; raise it first to keep more) and before the broker's first row collected live (rows an earlier import stored do not count, so a re-run after an interruption resumes where it stopped; the command prints the bound it uses), since the two collectors received the same uploads at slightly different times and those would otherwise be stored twice. `--after` and `--before` (RFC 3339) narrow or move the span.
- **Topics:** Meshstellar stores the payload but not the topic, so the topic is rebuilt from the envelope (`<root>/2/e/<channel>/<gateway>`, or `<root>/2/map/` for map reports). The root is each gateway's own, from its live rows where it has any, else the broker's subscription without `/#`, or `--topic-root`. Unless the broker has exactly one subscription of the form `<root>/#` (no other wildcards), `--topic-root` is required, even when every gateway has live rows.
- **Duplicates:** the same upload delivered twice within 15 minutes is stored once, as at ingest; JSON and status messages are skipped.
- **Browsers and caches:** an import advances the history revision when it starts and ends (D-158), which changes the rows' generation: browsers discard what they held and fetch their window again, and no cached day from before the import is used again. While it runs, no day is cached as final.

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
| Inspect real traffic | `docker run --rm eclipse-mosquitto:2 mosquitto_sub -h HOST -u U -P P -t 'msh/#' -F '%U\|%r\|%t\|%x' -W 600 > cap.txt` then `scripts/go.sh go run ./cmd/meshmap inspect ../cap.txt` (it runs in `backend/`) |

## Production security checklist

- [ ] Strong `POSTGRES_PASSWORD`; `.env` readable only by the deploy user, and `secrets/` only by the deploy user and the backend's user, uid 65532 (`sudo chgrp -R 65532 secrets && chmod 750 secrets && find secrets -type f -exec chmod 640 {} +`); neither is in Git.
- [ ] TLS in front of `web`; HSTS at the TLS proxy.
- [ ] `PUBLIC_METRICS_ENABLED=false` unless metrics are protected.
- [ ] Brokers use TLS where available; `accept_retained: false`.
- [ ] `SIGNATURE_POLICY=strict` if signed packets from unknown keys should be kept header-only as `invalid` (`iv=strict_unverifiable`) instead of `unverifiable`.
- [ ] `GEOLOCATION_EXCLUDE_NODE_IDS` lists nodes whose owners opted out of location estimates.
- [ ] Backups scheduled; restore tested.
