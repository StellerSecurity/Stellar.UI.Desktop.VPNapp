#!/bin/sh
set -e

OPENVPN="/usr/lib/stellar-vpn/openvpn"

echo "[stellar-vpn] prerm: removing OpenVPN capabilities..."

if [ -f "$OPENVPN" ] && command -v setcap >/dev/null 2>&1; then
  setcap -r "$OPENVPN" >/dev/null 2>&1 || true
fi

echo "[stellar-vpn] prerm: done."
exit 0
