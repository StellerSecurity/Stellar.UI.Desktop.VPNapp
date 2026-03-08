#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Stellar VPN.app"
APP_DIR_NAME="${APP_NAME%.app}"
HELPER_BIN_NAME="stellar-vpn-helper-macos"
HELPER_LABEL="org.stellarsecurity.vpn.helper"
SYSTEM_HELPER_PATH="/Library/PrivilegedHelperTools/${HELPER_BIN_NAME}"
SYSTEM_PLIST_PATH="/Library/LaunchDaemons/${HELPER_LABEL}.plist"
TMP_SOCKET_1="/tmp/stellar-vpn-helper.sock"
TMP_SOCKET_2="/var/run/stellar-vpn/stellar-vpn-helper.sock"
APP_TEMP_DIR="/tmp/stellar-vpn-desktop"

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

BUILD_MODE="internal"
TAURI_FEATURE_ARGS=()
CARGO_FEATURE_ARGS=()
VITE_SHOW_VPN_LOGS_VALUE="true"
WIPE_DATA="false"

usage() {
  cat <<EOF
Usage:
  ./reinstall_stellar_vpn_macos.sh [--internal|--customer] [--wipe-data]

Modes:
  --internal   Build internal version with VPN logs visible in dashboard
  --customer   Build customer version with VPN logs hidden in dashboard

Options:
  --wipe-data  Remove local app data, caches, WebKit storage, prefs, temp files

Default:
  --internal
EOF
}

read_bundle_id() {
  local conf="${REPO_ROOT}/src-tauri/tauri.conf.json"
  local id=""

  if [[ -f "${conf}" ]]; then
    id="$(/usr/bin/plutil -extract identifier raw -o - "${conf}" 2>/dev/null || true)"
    if [[ -z "${id}" ]]; then
      id="$(/usr/bin/plutil -extract tauri.bundle.identifier raw -o - "${conf}" 2>/dev/null || true)"
    fi
  fi

  if [[ -z "${id}" && -d "${APP_BUNDLE}" ]]; then
    id="$(/usr/bin/defaults read "${APP_BUNDLE}/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  fi

  printf '%s\n' "${id}"
}

wipe_app_data() {
  local bundle_id
  bundle_id="$(read_bundle_id)"

  echo "==> Removing local app data and caches"
  echo "    App name: ${APP_DIR_NAME}"
  if [[ -n "${bundle_id}" ]]; then
    echo "    Bundle id: ${bundle_id}"
  else
    echo "    Bundle id: not found, removing name-based paths only"
  fi

  rm -rf "${HOME}/Library/Application Support/${APP_DIR_NAME}" || true
  rm -rf "${HOME}/Library/Caches/${APP_DIR_NAME}" || true
  rm -rf "${HOME}/Library/WebKit/${APP_DIR_NAME}" || true
  rm -rf "${HOME}/Library/HTTPStorages/${APP_DIR_NAME}" || true
  rm -rf "${HOME}/Library/Logs/${APP_DIR_NAME}" || true
  rm -rf "${APP_TEMP_DIR}" || true

  if [[ -n "${bundle_id}" ]]; then
    rm -rf "${HOME}/Library/Application Support/${bundle_id}" || true
    rm -rf "${HOME}/Library/Caches/${bundle_id}" || true
    rm -rf "${HOME}/Library/WebKit/${bundle_id}" || true
    rm -rf "${HOME}/Library/HTTPStorages/${bundle_id}" || true
    rm -rf "${HOME}/Library/Logs/${bundle_id}" || true
    rm -f "${HOME}/Library/Preferences/${bundle_id}.plist" || true
    rm -rf "${HOME}/Library/Saved Application State/${bundle_id}.savedState" || true

    local byhost_matches=( "${HOME}/Library/Preferences/ByHost/${bundle_id}."*.plist )
    if [[ ${#byhost_matches[@]} -gt 0 ]]; then
      rm -f "${byhost_matches[@]}" || true
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --customer)
      BUILD_MODE="customer"
      TAURI_FEATURE_ARGS=(--features customer-build)
      CARGO_FEATURE_ARGS=(--features "macos-build,customer-build")
      VITE_SHOW_VPN_LOGS_VALUE="false"
      shift
      ;;
    --internal)
      BUILD_MODE="internal"
      TAURI_FEATURE_ARGS=()
      CARGO_FEATURE_ARGS=(--features macos-build)
      VITE_SHOW_VPN_LOGS_VALUE="true"
      shift
      ;;
    --wipe-data)
      WIPE_DATA="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
done

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
  if [[ ${#TAURI_FEATURE_ARGS[@]} -gt 0 ]]; then
    case "${PM}" in
      pnpm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        pnpm tauri build -- --no-sign "${TAURI_FEATURE_ARGS[@]}"
        ;;
      yarn)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        yarn tauri build -- --no-sign "${TAURI_FEATURE_ARGS[@]}"
        ;;
      npm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        npm run tauri:build -- --no-sign "${TAURI_FEATURE_ARGS[@]}"
        ;;
    esac
  else
    case "${PM}" in
      pnpm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        pnpm tauri build -- --no-sign
        ;;
      yarn)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        yarn tauri build -- --no-sign
        ;;
      npm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        npm run tauri:build -- --no-sign
        ;;
    esac
  fi
}

echo "==> Repo root: ${REPO_ROOT}"
echo "==> Package manager: ${PM}"
echo "==> Build mode: ${BUILD_MODE}"
echo "==> VITE_SHOW_VPN_LOGS: ${VITE_SHOW_VPN_LOGS_VALUE}"
echo "==> Wipe data: ${WIPE_DATA}"
if [[ ${#TAURI_FEATURE_ARGS[@]} -gt 0 ]]; then
  echo "==> Tauri feature args: ${TAURI_FEATURE_ARGS[*]}"
else
  echo "==> Tauri feature args: none"
fi

echo "==> Requesting sudo access"
sudo -v

echo "==> Stopping old app/helper/VPN"
sudo launchctl bootout system "${SYSTEM_PLIST_PATH}" 2>/dev/null || true
sudo pkill -f "${HELPER_BIN_NAME}" || true
sudo pkill -f openvpn || true
pkill -f stellar-vpn-desktop || true
pkill -f "Stellar VPN" || true

echo "==> Removing old helper sockets"
sudo rm -f "${TMP_SOCKET_1}" || true
sudo rm -f "${TMP_SOCKET_2}" || true

if [[ "${WIPE_DATA}" == "true" ]]; then
  wipe_app_data
fi

echo "==> Cleaning previous Rust build output"
rm -rf "${REPO_ROOT}/src-tauri/target"
mkdir -p "${REPO_ROOT}/src-tauri/bin"

echo "==> Building privileged helper"
cd "${REPO_ROOT}/src-tauri"
STELLAR_HELPER_BUILDING=1 \
VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
cargo build --release --bin "${HELPER_BIN_NAME}" "${CARGO_FEATURE_ARGS[@]}"

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

echo "Done, Stellar VPN."