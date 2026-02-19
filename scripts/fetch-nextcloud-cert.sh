#!/usr/bin/env bash
# Fetch the Nextcloud server's TLS certificate and save as PEM for NODE_EXTRA_CA_CERTS.
# Run from repo root on a host that can reach Nextcloud (e.g. your Jeeves/homeserver).
# With Traefik in front, this fetches the cert Traefik presents to clients — the right one for Node to trust.
# Requires: openssl.
#
# Usage: ./scripts/fetch-nextcloud-cert.sh
# Env:    NC_HOST (default 192.168.7.50), NC_PORT (default 443), NC_SNI (optional; use if you access via hostname)
#         Traefik often serves TLS on 443 and HTTP on 8443; use NC_PORT=443 to fetch the cert. Set NC_SNI if you use a hostname in the browser.
# Then ensure .env has: NODE_EXTRA_CA_CERTS=<absolute-path-to-config/nextcloud-server.pem>
# Restart Jeeves so Node trusts the Nextcloud HTTPS server.

set -e
NC_HOST="${NC_HOST:-192.168.7.50}"
NC_PORT="${NC_PORT:-443}"
# SNI hostname Traefik uses to pick the cert (set if you access Nextcloud by hostname, not IP)
NC_SNI="${NC_SNI:-$NC_HOST}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/config"
OUT_FILE="$OUT_DIR/nextcloud-server.pem"

mkdir -p "$OUT_DIR"
echo "Fetching certificate from $NC_HOST:$NC_PORT (SNI: $NC_SNI) ..."
# s_client may print cert to stdout or stderr depending on OpenSSL version; capture both (timeout 10s)
# Don't let timeout/openssl non-zero exit abort the script (set -e); we check for cert below and show RAW on failure
RAW=$(echo | timeout 10 openssl s_client -connect "$NC_HOST:$NC_PORT" -servername "$NC_SNI" -showcerts 2>&1) || true
# Extract full chain (server cert + intermediates/CA) so Node can verify when Traefik uses a private/self-signed CA
echo "$RAW" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' | head -n 100 > "$OUT_FILE"
if ! grep -q "BEGIN CERTIFICATE" "$OUT_FILE"; then
  echo "No certificate found. OpenSSL output (first 20 lines):" >&2
  echo "$RAW" | head -20 >&2
  echo "" >&2
  echo "If you see 'wrong version number': the port may be HTTP, not HTTPS, or something else is on $NC_PORT." >&2
  echo "If Nextcloud is behind Traefik/Caddy, ensure you're connecting to the TLS endpoint (e.g. the same URL as in the browser)." >&2
  exit 1
fi
echo "Saved to $OUT_FILE"
echo "Ensure .env contains (then restart Jeeves):"
echo "NODE_EXTRA_CA_CERTS=$OUT_FILE"
if [ "$NC_SNI" != "$NC_HOST" ] && [ -n "$NC_SNI" ]; then
  echo "Set NEXTCLOUD_URL=https://$NC_SNI in .env so the app uses the same hostname as Traefik."
fi
