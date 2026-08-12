#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.rk3566.yml}"

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d

echo "Waiting for local services..."
sleep 3
curl -fsS http://127.0.0.1:3000/api/state >/dev/null
curl -fsS http://127.0.0.1:3100/api/health >/dev/null
echo "Update completed."
