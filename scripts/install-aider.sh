#!/bin/bash
# Install Aider for Jeeves orchestrator.
# On Ubuntu 24.04+ (PEP 668), use pipx or venv. Run: bash scripts/install-aider.sh

set -e

echo "Installing Aider..."

if command -v pipx &>/dev/null; then
  echo "Using pipx (isolated install)..."
  pipx install aider-chat
elif python3 -c "import venv" 2>/dev/null; then
  echo "Using venv (Python 3 venv)..."
  VENV_DIR="${AIDER_VENV:-$HOME/.local/share/aider-venv}"
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install aider-chat
  echo ""
  echo "Add to PATH or set AIDER_BIN: export PATH=\"$VENV_DIR/bin:\$PATH\""
  echo "Or in .env: AIDER_BIN=$VENV_DIR/bin/aider"
else
  echo "Error: Need pipx (apt install pipx && pipx ensurepath) or python3-venv."
  exit 1
fi

echo ""
echo "Verifying..."
aider --version 2>/dev/null || "$HOME/.local/bin/aider" --version 2>/dev/null || true

echo ""
echo "Done. Set ANTHROPIC_API_KEY and use 'build ...' or 'orchestrate ...'."
