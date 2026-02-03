#!/usr/bin/env bash
set -euo pipefail

cd src-tauri

cargo build --release --bin stellar-vpn-helper-macos

mkdir -p bin
cp -f target/release/stellar-vpn-helper-macos bin/stellar-vpn-helper-macos
chmod +x bin/stellar-vpn-helper-macos
