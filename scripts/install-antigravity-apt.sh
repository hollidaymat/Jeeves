#!/usr/bin/env bash
# Install or update Google Antigravity via official APT repository (Ubuntu/Debian).
# Run with: sudo bash scripts/install-antigravity-apt.sh

set -e

echo "=== Antigravity install/update via Google APT repo ==="

# Dependencies
apt-get update -qq
apt-get install -y curl gpg

# GPG key
curl -fsSL https://us-central1-apt.pkg.dev/doc/repo-signing-key.gpg | gpg --dearmor -o /usr/share/keyrings/google-antigravity.gpg

# Repository (DEB822 format)
echo 'Types: deb
URIs: https://us-central1-apt.pkg.dev/projects/antigravity-auto-updater-dev/
Suites: antigravity-debian
Components: main
Signed-By: /usr/share/keyrings/google-antigravity.gpg' > /etc/apt/sources.list.d/google-antigravity.sources

# Install or upgrade
apt-get update -qq
apt-get install -y --only-upgrade antigravity 2>/dev/null || apt-get install -y antigravity

echo ""
echo "Installed version:"
dpkg-query -W -f='${Package} ${Version}\n' antigravity 2>/dev/null || true
which antigravity
antigravity --version 2>/dev/null || true
echo ""
echo "Check for tunnel binary (needed for serve-web):"
ls -la /usr/share/antigravity/bin/ 2>/dev/null || echo "No bin dir or missing"
echo ""
echo "Done. Try: antigravity --version && PORT=3010 antigravity serve-web"
