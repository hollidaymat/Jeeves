#!/usr/bin/env bash
# Move recent downloads from /data/downloads (top-level) into /data/downloads/quarantine.
# Skips standard subdirs: incomplete, quarantine, torrents, usenet.
# Run once after fixing qBittorrent save path so items that landed in the wrong place are moved.

set -e
DOWNLOADS="${1:-/data/downloads}"
QUARANTINE="${DOWNLOADS}/quarantine"
SKIP_DIRS="incomplete quarantine torrents usenet"

mkdir -p "$QUARANTINE"

moved=0
for name in "$DOWNLOADS"/*; do
  [[ -e "$name" ]] || continue
  base=$(basename "$name")
  # Skip standard subdirs
  skip=
  for s in $SKIP_DIRS; do
    if [[ "$base" == "$s" ]]; then skip=1; break; fi
  done
  [[ -n "$skip" ]] && continue
  dest="$QUARANTINE/$base"
  if [[ -e "$dest" ]]; then
    echo "Skip (already exists in quarantine): $base" >&2
    continue
  fi
  echo "Moving: $base -> quarantine/"
  mv "$name" "$dest"
  ((moved++)) || true
done

echo "Moved $moved item(s) to $QUARANTINE."
