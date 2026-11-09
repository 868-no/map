#!/usr/bin/env bash
# Run backend integration tests against throwaway Postgres, Redis and
# Mosquitto containers on a private Docker network. Host needs only Docker.
#   scripts/integration.sh [go test args...]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$repo/versions.env"
net="meshmap-it-$$"
cleanup() { docker rm -f "$net-pg" "$net-redis" "$net-mqtt" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$net" >/dev/null
docker run -d --name "$net-pg" --network "$net" -e POSTGRES_PASSWORD=it -e POSTGRES_DB=meshmap_it "$POSTGRES_IMAGE" >/dev/null
docker run -d --name "$net-redis" --network "$net" "$REDIS_IMAGE" redis-server --save "" --appendonly no >/dev/null
docker run -d --name "$net-mqtt" --network "$net" -v "$repo/deploy/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" "$MOSQUITTO_IMAGE" >/dev/null
until docker exec "$net-pg" pg_isready -q -U postgres 2>/dev/null; do sleep 1; done
sleep 1
GO_NETWORK="$net" "$repo/scripts/go.sh" env \
  MESHMAP_IT_DATABASE_URL="postgres://postgres:it@$net-pg:5432/meshmap_it?sslmode=disable" \
  MESHMAP_IT_REDIS_URL="redis://$net-redis:6379/0" \
  MESHMAP_IT_MQTT_HOST="$net-mqtt" \
  MESHMAP_IT_MQTT_CONTAINER="$net-mqtt" \
  go test -tags integration -count=1 "${@:-./test/integration/...}"
