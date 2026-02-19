#!/usr/bin/env bash
# Test Radarr and Sonarr when qBittorrent is down. Expects both to return
# "Unable to connect" / connection refused. Loads API keys from .env in repo root
# or from env (RADARR_API_KEY, SONARR_API_KEY). Run from this directory or repo root.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
[[ -f "$ENV_FILE" ]] || ENV_FILE=".env"
RADARR_URL="${RADARR_URL:-http://192.168.7.50:7878}"
SONARR_URL="${SONARR_URL:-http://192.168.7.50:8989}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^RADARR_API_KEY=|^SONARR_API_KEY=' "$ENV_FILE" | tr -d '\r' | sed 's/^/export /')
  set +a
fi

[[ -n "$RADARR_API_KEY" ]] || { echo "RADARR_API_KEY not set"; exit 1; }
[[ -n "$SONARR_API_KEY" ]] || { echo "SONARR_API_KEY not set"; exit 1; }

COMPOSE_DIR="$SCRIPT_DIR"
cd "$COMPOSE_DIR"
docker compose stop qbittorrent
sleep 2

radarr_body=$(curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/downloadclient" | jq -c '.[] | select(.implementation=="QBittorrent") | .')
sonarr_body=$(curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/downloadclient" | jq -c '.[] | select(.implementation=="QBittorrent") | .')

radarr_code=0
radarr_out=$(curl -s -w "\n%{http_code}" -o /tmp/radarr_test.json -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" -d "$radarr_body" "$RADARR_URL/api/v3/downloadclient/test") || true
radarr_http=$(echo "$radarr_out" | tail -1)
radarr_err=$(jq -r '.[0].errorMessage // empty' /tmp/radarr_test.json 2>/dev/null)
[[ "$radarr_http" == "400" && "$radarr_err" == *"Unable to connect"* ]] || { echo "Radarr: expected HTTP 400 + 'Unable to connect', got HTTP $radarr_http: $radarr_err"; radarr_code=1; }

sonarr_code=0
sonarr_out=$(curl -s -w "\n%{http_code}" -o /tmp/sonarr_test.json -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" -d "$sonarr_body" "$SONARR_URL/api/v3/downloadclient/test") || true
sonarr_http=$(echo "$sonarr_out" | tail -1)
sonarr_err=$(jq -r '.[0].errorMessage // empty' /tmp/sonarr_test.json 2>/dev/null)
[[ "$sonarr_http" == "400" && "$sonarr_err" == *"Unable to connect"* ]] || { echo "Sonarr: expected HTTP 400 + 'Unable to connect', got HTTP $sonarr_http: $sonarr_err"; sonarr_code=1; }

docker compose start qbittorrent

if [[ $radarr_code -eq 0 && $sonarr_code -eq 0 ]]; then
  echo "OK: Radarr and Sonarr both reported qBittorrent unreachable when stopped."
  exit 0
fi
exit 1
