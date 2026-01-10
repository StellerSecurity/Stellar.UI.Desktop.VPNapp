#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="public/flags"
mkdir -p "$OUT_DIR"

# Put the country codes you actually need here (lowercase).
CODES=(
  ch de us dk se no fi nl be fr it es pt at pl cz sk hu ro bg gr ie gb
)

BASE="https://flagcdn.com"

echo "[+] Downloading flags into $OUT_DIR ..."
for cc in "${CODES[@]}"; do
  url="$BASE/${cc}.svg"
  out="$OUT_DIR/${cc}.svg"

  echo " - $cc"
  curl -fsSL "$url" -o "$out"
done

echo "[+] Done."
