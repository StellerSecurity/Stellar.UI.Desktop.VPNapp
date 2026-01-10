#!/usr/bin/env bash
set -euo pipefail

# Dev helper for Linux:
# Runs Tauri dev under sudo so nft/iptables + OpenVPN tun works.
# This is NOT a production solution. For production, ship a privileged helper/service.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[+] Using repo: $ROOT_DIR"
cd "$ROOT_DIR"

echo "[+] Installing JS deps (if needed)…"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "[+] Running Tauri dev with sudo…"
# -E keeps env vars like PATH, RUST_BACKTRACE, etc.
sudo -E npm run tauri dev
