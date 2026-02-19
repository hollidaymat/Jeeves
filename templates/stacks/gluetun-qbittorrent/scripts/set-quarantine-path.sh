#!/usr/bin/env bash
# Set qBittorrent default save path to /downloads/quarantine (host: /data/downloads/quarantine).
# Run this after a qBittorrent reinstall or config reset so new torrents land in quarantine.
# Loads QBITTORRENT_URL, QBITTORRENT_USER, QBITTORRENT_PASS from .env (repo root or current dir).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
[[ -f "$ENV_FILE" ]] || ENV_FILE=".env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC2046
  export $(grep -E '^QBITTORRENT_URL=|^QBITTORRENT_USER=|^QBITTORRENT_PASS=' "$ENV_FILE" | tr -d '\r' | xargs)
  set +a
fi

BASE_URL="${QBITTORRENT_URL:-http://192.168.7.50:8085}"
USER="${QBITTORRENT_USER:-admin}"
PASS="${QBITTORRENT_PASS:-}"

if [[ -z "$PASS" ]]; then
  echo "QBITTORRENT_PASS not set. Set it in .env or pass env." >&2
  exit 1
fi

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

LOGIN_RESP=$(curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" -H "Referer: $BASE_URL" \
  -d "username=$USER&password=$PASS" \
  "$BASE_URL/api/v2/auth/login")
if [[ "$LOGIN_RESP" != "Ok." ]]; then
  echo "Login failed: $LOGIN_RESP" >&2
  exit 1
fi

# Get current preferences, set save_path, POST back (form-encoded json=)
PREFS=$(curl -s -b "$COOKIE_JAR" -H "Referer: $BASE_URL" "$BASE_URL/api/v2/app/preferences")
NEW_PREFS=$(echo "$PREFS" | jq -c '.save_path = "/downloads/quarantine"')
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" -b "$COOKIE_JAR" -H "Referer: $BASE_URL" \
  --data-urlencode "json=$NEW_PREFS" \
  "$BASE_URL/api/v2/app/setPreferences")

if [[ "$STATUS" != "200" ]]; then
  echo "setPreferences returned HTTP $STATUS" >&2
  exit 1
fi

echo "qBittorrent default save path set to /downloads/quarantine."
