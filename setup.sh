#!/usr/bin/env bash
# Midnight dev stack setup — run inside WSL (Windows), Linux, or macOS.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/4 Compact toolchain"
if ! command -v compact >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"
fi
compact update
compact compile --version

echo "==> 2/4 App dependencies"
cd midnight-app
npm install --no-audit --no-fund

echo "==> 3/4 Compile contract"
npm run compile

echo "==> 4/4 Local devnet (node + indexer + proof server)"
if docker info >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    echo "NOTE: Apple Silicon detected. Official arm64 proof-server image has a known bug."
    echo "If proofs fail, edit docker-compose.yml to use bricktowers/proof-server:latest"
  fi
  npm run setup   # boots devnet, compiles, deploys
else
  echo "Docker is not running. Start Docker Desktop, then run: cd midnight-app && npm run setup"
fi

echo "Done. Interact with the contract: cd midnight-app && npm run cli"
echo "Wallet + VS Code extension: see SETUP.md (manual browser steps)."
