#!/usr/bin/env bash
# Reference-workload benchmark (spec §11): seed a throwaway PostgreSQL with
# synthetic observations, then measure API latency. Database and Redis are
# limited to 4 vCPU / 8 GiB like the spec's reference machine.
#   scripts/bench.sh [rows] [nodes]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rows="${1:-2000000}"; nodes="${2:-2000}"
net="meshmap-bench-$$"
cleanup() { docker rm -f "$net-pg" "$net-redis" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$net" >/dev/null
docker run -d --name "$net-pg" --network "$net" --cpus 4 --memory 8g -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=meshmap_bench \
  postgres:16-alpine postgres -c shared_buffers=2GB -c effective_cache_size=6GB -c work_mem=64MB -c maintenance_work_mem=512MB -c max_wal_size=4GB -c random_page_cost=1.1 >/dev/null
docker run -d --name "$net-redis" --network "$net" --cpus 1 --memory 512m redis:7-alpine redis-server --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru >/dev/null
until docker exec "$net-pg" pg_isready -q -U postgres 2>/dev/null; do sleep 1; done
sleep 1
run() { GO_NETWORK="$net" "$repo/scripts/go.sh" env DATABASE_URL="postgres://postgres:bench@$net-pg:5432/meshmap_bench?sslmode=disable" REDIS_URL="redis://$net-redis:6379/0" "$@"; }
echo "== hardware: $(nproc) host CPUs, $(free -g | awk '/Mem:/{print $2}') GiB host RAM; DB limited to 4 vCPU / 8 GiB"
run go run ./cmd/meshmap seed --rows "$rows" --nodes "$nodes" --days 30
docker exec "$net-pg" psql -U postgres -d meshmap_bench -Atc "SELECT 'table+indexes: ' || pg_size_pretty(pg_total_relation_size('packet_log'))"
for h in 72 168 24; do run go run ./cmd/meshmap bench --hours "$h" --n 8; done
