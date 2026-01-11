#!/bin/sh
set -e

OPENVPN="/usr/lib/stellar-vpn/openvpn"

echo "[stellar-vpn] postinst: configuring OpenVPN capabilities..."

if [ -f "$OPENVPN" ]; then
  chown root:root "$OPENVPN" || true
  chmod 0755 "$OPENVPN" || true

  if command -v setcap >/dev/null 2>&1; then
    # Minimum needed for TUN + routing without running the whole app as root.
    setcap cap_net_admin,cap_net_raw+ep "$OPENVPN" || true
    echo "[stellar-vpn] postinst: setcap applied to $OPENVPN"
  else
    echo "[stellar-vpn] postinst: setcap not found (dependency missing?)"
  fi
else
  echo "[stellar-vpn] postinst: OpenVPN binary not found at $OPENVPN"
fi

# Ensure tun module exists (best-effort; don't hard-fail installs)
if command -v modprobe >/dev/null 2>&1; then
  modprobe tun >/dev/null 2>&1 || true
fi

if [ ! -c /dev/net/tun ]; then
  echo "[stellar-vpn] postinst: WARNING /dev/net/tun missing. VPN will not work until it exists."
fi

echo "[stellar-vpn] postinst: done."
exit 0
