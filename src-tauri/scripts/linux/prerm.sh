#!/bin/sh
set -eu

OPENVPN="/usr/lib/stellar-vpn/openvpn"
HELPER="/usr/libexec/stellar-vpn/stellar-vpn-helper"

log() {
  echo "[stellar-vpn] prerm: $*"
}

log "starting..."

# Remove killswitch table if present (best-effort).
if command -v nft >/dev/null 2>&1; then
  nft delete table inet stellarkillswitch >/dev/null 2>&1 || true
  log "killswitch table removed (best-effort)"
fi

# Remove capabilities (best-effort).
if command -v setcap >/dev/null 2>&1; then
  [ -f "$OPENVPN" ] && setcap -r "$OPENVPN" >/dev/null 2>&1 || true
  [ -f "$HELPER" ]  && setcap -r "$HELPER"  >/dev/null 2>&1 || true
  log "capabilities removed (best-effort)"
fi

log "done."
exit 0