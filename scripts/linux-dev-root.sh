#!/usr/bin/env bash
set -euo pipefail

# Gives the built Tauri binary CAP_NET_ADMIN so nftables kill switch can work in dev.
# Warning: cargo rebuilds overwrite capabilities. Re-run this script after rebuilds.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"

if [[ ! -d "$TAURI_DIR" ]]; then
  echo "[!] Could not find src-tauri directory at: $TAURI_DIR"
  exit 1
fi

SUDO=""
if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

echo "[+] Building Rust backend (debug)…"
(cd "$TAURI_DIR" && cargo build)

BIN="$TAURI_DIR/target/debug/stellar-vpn-desktop"

if [[ ! -f "$BIN" ]]; then
  echo "[!] Binary not found at $BIN"
  echo "    If your binary name differs, update BIN in scripts/linux-dev-caps.sh"
  exit 1
fi

if ! command -v setcap >/dev/null 2>&1; then
  echo "[!] setcap not found."
  echo "    Install it: $SUDO apt-get install -y libcap2-bin"
  exit 1
fi

echo "[+] Setting capabilities on:"
echo "    $BIN"
$SUDO setcap cap_net_admin,cap_net_raw+eip "$BIN"

echo "[+] Verifying caps:"
getcap "$BIN" || true

echo "[+] Done."
echo "    Now run your dev command (npm run tauri:dev)."
echo "    If you rebuild and caps disappear, rerun this script."
