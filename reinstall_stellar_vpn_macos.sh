#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Stellar VPN.app"
HELPER_BIN_NAME="stellar-vpn-helper-macos"
HELPER_LABEL="org.stellarsecurity.vpn.helper"
SYSTEM_HELPER_PATH="/Library/PrivilegedHelperTools/${HELPER_BIN_NAME}"
SYSTEM_PLIST_PATH="/Library/LaunchDaemons/${HELPER_LABEL}.plist"
TMP_SOCKET_1="/tmp/stellar-vpn-helper.sock"
TMP_SOCKET_2="/var/run/stellar-vpn/stellar-vpn-helper.sock"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
if [[ ! -d "${REPO_ROOT}/src-tauri" ]]; then
  REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
fi

if [[ ! -d "${REPO_ROOT}/src-tauri" ]]; then
  echo "Error: could not find src-tauri. Put this script in the repo root or one folder below it." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: this script is for macOS only." >&2
  exit 1
fi

cd "${REPO_ROOT}"

HELPER_SRC="${REPO_ROOT}/src-tauri/bin/${HELPER_BIN_NAME}.rs"
HELPER_OUT="${REPO_ROOT}/src-tauri/bin/${HELPER_BIN_NAME}"
APP_BUNDLE="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}"

if [[ ! -f "${HELPER_SRC}" ]]; then
  echo "Error: helper source not found at ${HELPER_SRC}" >&2
  exit 1
fi

choose_package_manager() {
  if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
    echo "pnpm"
    return
  fi
  if command -v yarn >/dev/null 2>&1 && [[ -f yarn.lock ]]; then
    echo "yarn"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "npm"
    return
  fi
  echo ""
}

PM="$(choose_package_manager)"
if [[ -z "${PM}" ]]; then
  echo "Error: could not find pnpm, yarn, or npm." >&2
  exit 1
fi

run_tauri_build() {
  case "${PM}" in
    pnpm)
      STELLAR_HELPER_BUILDING=1 pnpm tauri build -- --no-sign
      ;;
    yarn)
      STELLAR_HELPER_BUILDING=1 yarn tauri build -- --no-sign
      ;;
    npm)
      STELLAR_HELPER_BUILDING=1 npm run tauri:build -- --no-sign
      ;;
  esac
}

echo "==> Repo root: ${REPO_ROOT}"
echo "==> Package manager: ${PM}"

echo "==> Requesting sudo access"
sudo -v

echo "==> Stopping old app/helper/VPN"
sudo launchctl bootout system "${SYSTEM_PLIST_PATH}" 2>/dev/null || true
sudo pkill -f "${HELPER_BIN_NAME}" || true
sudo pkill -f openvpn || true
pkill -f stellar-vpn-desktop || true


echo "==> Removing old helper sockets"
sudo rm -f "${TMP_SOCKET_1}" || true
sudo rm -f "${TMP_SOCKET_2}" || true

echo "==> Cleaning previous Rust build output"
rm -rf "${REPO_ROOT}/src-tauri/target"
mkdir -p "${REPO_ROOT}/src-tauri/bin"

echo "==> Building privileged helper"
cd "${REPO_ROOT}/src-tauri"
STELLAR_HELPER_BUILDING=1 cargo build --release --bin "${HELPER_BIN_NAME}" --features macos-build
cp -f "target/release/${HELPER_BIN_NAME}" "bin/${HELPER_BIN_NAME}"
ls -l "bin/${HELPER_BIN_NAME}"

echo "==> Building app bundle"
cd "${REPO_ROOT}"
run_tauri_build

if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "Error: app bundle not found at ${APP_BUNDLE}" >&2
  exit 1
fi

echo "==> Installing freshly built helper"
sudo cp -f "${HELPER_OUT}" "${SYSTEM_HELPER_PATH}"
sudo chown root:wheel "${SYSTEM_HELPER_PATH}"
sudo chmod 755 "${SYSTEM_HELPER_PATH}"

if [[ -f "${SYSTEM_PLIST_PATH}" ]]; then
  echo "==> Restarting LaunchDaemon"
  sudo launchctl bootstrap system "${SYSTEM_PLIST_PATH}" 2>/dev/null || true
  sudo launchctl kickstart -k "system/${HELPER_LABEL}"
else
  echo "==> LaunchDaemon plist not found at ${SYSTEM_PLIST_PATH}"
  echo "    The app may need to install the helper once when it starts."
fi

echo "==> Verifying helper"
pgrep -af "${HELPER_BIN_NAME}" || true
sudo launchctl list | grep -i stellar || true

echo "==> Opening freshly built app"
open "${APP_BUNDLE}"

echo "Done. Test: connect VPN, turn Wi-Fi off, turn Wi-Fi on, wait up to 45 seconds."
