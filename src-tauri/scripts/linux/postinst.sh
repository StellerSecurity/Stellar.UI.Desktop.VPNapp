#!/bin/sh
set -eu

OPENVPN="/usr/lib/stellar-vpn/openvpn"
HELPER="/usr/libexec/stellar-vpn/stellar-vpn-helper"
POLKIT_POLICY="/usr/share/polkit-1/actions/org.stellarsecurity.vpn.desktop.helper.policy"

log() {
  echo "[stellar-vpn] postinst: $*"
}

log "starting..."

# --- OpenVPN binary ---
if [ -f "$OPENVPN" ]; then
  chown root:root "$OPENVPN" || true
  chmod 0755 "$OPENVPN" || true
  log "openvpn perms set: $OPENVPN"
else
  log "WARNING: openvpn not found at $OPENVPN"
fi

# --- Helper binary (optional but recommended) ---
if [ -f "$HELPER" ]; then
  chown root:root "$HELPER" || true
  chmod 0755 "$HELPER" || true
  log "helper perms set: $HELPER"
else
  log "NOTE: helper not found at $HELPER (ok if you don't ship it yet)"
fi

# --- Polkit policy (optional) ---
if [ -f "$POLKIT_POLICY" ]; then
  chown root:root "$POLKIT_POLICY" || true
  chmod 0644 "$POLKIT_POLICY" || true
  log "polkit policy perms set: $POLKIT_POLICY"
else
  log "NOTE: polkit policy not found at $POLKIT_POLICY"
fi

# --- Capabilities for OpenVPN (best-effort) ---
if [ -f "$OPENVPN" ]; then
  if command -v setcap >/dev/null 2>&1; then
    # Minimum needed for TUN + routing without running whole app as root.
    if setcap cap_net_admin,cap_net_raw+eip "$OPENVPN" 2>/dev/null; then
      log "setcap applied to $OPENVPN"
      if command -v getcap >/dev/null 2>&1; then
        cap="$(getcap "$OPENVPN" 2>/dev/null || true)"
        if [ -n "${cap:-}" ]; then
          log "verified caps: $cap"
        else
          log "WARNING: setcap ran but getcap shows nothing (filesystem may not support xattrs/caps)"
        fi
      fi
    else
      log "WARNING: setcap failed (capabilities not applied). VPN may require sudo/polkit helper."
    fi
  else
    log "WARNING: setcap not found (missing libcap tools)."
  fi
fi

# --- TUN device check (non-fatal) ---
if command -v modprobe >/dev/null 2>&1; then
  modprobe tun >/dev/null 2>&1 || true
fi

if [ ! -c /dev/net/tun ]; then
  log "WARNING: /dev/net/tun missing. VPN will not work until TUN is available."
else
  # Permission hint. Often the node exists but isn't usable by the user.
  if [ ! -r /dev/net/tun ] || [ ! -w /dev/net/tun ]; then
    log "NOTE: /dev/net/tun exists but may require privileges (caps/polkit) to use."
  fi
fi

log "done."
exit 0
