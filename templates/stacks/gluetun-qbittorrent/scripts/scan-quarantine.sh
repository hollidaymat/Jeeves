#!/usr/bin/env bash
# Scan /data/downloads/quarantine with ClamAV; move infected items to quarantine/infected/.
# Run on a schedule (e.g. cron every 1-2 min) so scans complete before *arr completed-download handling.
# Optional: remove infected torrents from qBittorrent via API (set QBITTORRENT_* in .env).
# Requires: clamscan (apt install clamav) or run inside a container that has ClamAV + this script.
# Idempotent; skips the infected/ subdir.

set -e
QUARANTINE_DIR="${QUARANTINE_DIR:-/data/downloads/quarantine}"
INFECTED_DIR="$QUARANTINE_DIR/infected"
SKIP_DIR="infected"
CLAMSCAN="${CLAMSCAN:-clamscan}"
# Use clamdscan if a daemon is available (faster for repeated scans): CLAMSCAN=clamdscan

# Optional qBittorrent API: remove torrent when moving to infected (needs QBITTORRENT_* in env)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
[[ -f "$ENV_FILE" ]] || ENV_FILE=".env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC2046
  export $(grep -E '^QBITTORRENT_URL=|^QBITTORRENT_USER=|^QBITTORRENT_PASS=' "$ENV_FILE" | tr -d '\r' | xargs) 2>/dev/null || true
  set +a
fi

if [[ ! -d "$QUARANTINE_DIR" ]]; then
  echo "Quarantine dir not found: $QUARANTINE_DIR" >&2
  exit 1
fi

if ! command -v "$CLAMSCAN" &>/dev/null; then
  echo "ClamAV not found. Install with: apt install clamav; freshclam to update defs. Or set CLAMSCAN to a clamscan path." >&2
  exit 1
fi

mkdir -p "$INFECTED_DIR"
moved=0

# Optional qBittorrent: login once and reuse for all deletes
COOKIE_JAR=""
if [[ -n "${QBITTORRENT_PASS:-}" ]]; then
  BASE_URL="${QBITTORRENT_URL:-http://192.168.7.50:8085}"
  USER="${QBITTORRENT_USER:-admin}"
  COOKIE_JAR=$(mktemp)
  trap 'rm -f "$COOKIE_JAR"' EXIT
  LOGIN_RESP=$(curl -s -c "$COOKIE_JAR" -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" -H "Referer: $BASE_URL" \
    -d "username=$USER&password=$QBITTORRENT_PASS" \
    "$BASE_URL/api/v2/auth/login")
  if [[ "$LOGIN_RESP" != "Ok." ]]; then
    rm -f "$COOKIE_JAR"
    trap - EXIT
    COOKIE_JAR=""
  fi
fi
qb_path_prefix="/downloads/quarantine/"

for item in "$QUARANTINE_DIR"/*; do
  [[ -e "$item" ]] || continue
  base=$(basename "$item")
  [[ "$base" == "$SKIP_DIR" ]] && continue
  dest="$INFECTED_DIR/$base"
  if [[ -e "$dest" ]]; then
    continue
  fi
  # Scan this item (file or directory). clamscan exits 1 if virus found, 2 on error.
  if "$CLAMSCAN" -r --no-summary "$item" &>/dev/null; then
    : # clean
  else
    rc=$?
    if [[ $rc -eq 1 ]]; then
      echo "infected: $item"
      mv "$item" "$dest"
      ((moved++)) || true
      if [[ -n "$COOKIE_JAR" && -f "$COOKIE_JAR" ]]; then
        match_path="${qb_path_prefix}${base}"
        hashes=$(curl -s -b "$COOKIE_JAR" -H "Referer: $BASE_URL" "$BASE_URL/api/v2/torrents/info" \
          | jq -r --arg path "$match_path" '.[] | select((.save_path + "/" + .name) == $path or .save_path == $path) | .hash' | tr '\n' '|' | sed 's/|$//')
        if [[ -n "$hashes" ]]; then
          curl -s -o /dev/null -X POST -b "$COOKIE_JAR" -H "Referer: $BASE_URL" \
            -d "hashes=$hashes&deleteFiles=false" \
            "$BASE_URL/api/v2/torrents/delete" || true
        fi
      fi
    fi
  fi
done

if [[ $moved -gt 0 ]]; then
  echo "Moved $moved infected item(s) to $INFECTED_DIR"
fi
