#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Stellar VPN"
APP_BIN_NAME="stellar-vpn-desktop"
HELPER_BIN_NAME="stellar-vpn-helper"
SYSTEM_HELPER_PATH="/usr/libexec/stellar-vpn/${HELPER_BIN_NAME}"
TMP_SOCKET_1="/tmp/stellar-vpn-helper.sock"
TMP_SOCKET_2="/var/run/stellar-vpn/stellar-vpn-helper.sock"
TMP_APP_DIR="/tmp/stellar-vpn-desktop"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
if [[ ! -d "${REPO_ROOT}/src-tauri" ]]; then
  REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
fi

if [[ ! -d "${REPO_ROOT}/src-tauri" ]]; then
  echo "Error: could not find src-tauri. Put this script in the repo root or one folder below it." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: this script is for Linux only." >&2
  exit 1
fi

cd "${REPO_ROOT}"

HELPER_SRC="${REPO_ROOT}/src-tauri/bin/${HELPER_BIN_NAME}.rs"
HELPER_OUT="${REPO_ROOT}/src-tauri/bin/${HELPER_BIN_NAME}"
APPIMAGE_DIR="${REPO_ROOT}/src-tauri/target/release/bundle/appimage"

if [[ ! -f "${HELPER_SRC}" ]]; then
  echo "Error: helper source not found at ${HELPER_SRC}" >&2
  exit 1
fi

BUILD_MODE="internal"
WIPE_DATA="false"
OPEN_AFTER_BUILD="true"
TAURI_FEATURE_ARGS=()
CARGO_FEATURE_ARGS=()
VITE_SHOW_VPN_LOGS_VALUE="true"
VITE_OTA_TARGET_VALUE="appimage"

usage() {
  cat <<EOF
Usage:
  ./reinstall_stellar_vpn_linux.sh [--internal|--customer] [--wipe-data] [--no-open]

Modes:
  --internal   Build internal version with VPN logs visible in dashboard
  --customer   Build customer version with VPN logs hidden in dashboard

Options:
  --wipe-data  Remove local app data/cache/state before launch
  --no-open    Do not launch the built app after build/install

Default:
  --internal
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --customer)
      BUILD_MODE="customer"
      TAURI_FEATURE_ARGS=(--features customer-build)
      CARGO_FEATURE_ARGS=(--features customer-build)
      VITE_SHOW_VPN_LOGS_VALUE="false"
      shift
      ;;
    --internal)
      BUILD_MODE="internal"
      TAURI_FEATURE_ARGS=()
      CARGO_FEATURE_ARGS=()
      VITE_SHOW_VPN_LOGS_VALUE="true"
      shift
      ;;
    --wipe-data)
      WIPE_DATA="true"
      shift
      ;;
    --no-open)
      OPEN_AFTER_BUILD="false"
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
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        pnpm tauri build -- "${TAURI_FEATURE_ARGS[@]}"
        ;;
      yarn)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        yarn tauri build -- "${TAURI_FEATURE_ARGS[@]}"
        ;;
      npm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        npm run tauri:build -- "${TAURI_FEATURE_ARGS[@]}"
        ;;
    esac
  else
    case "${PM}" in
      pnpm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        pnpm tauri build
        ;;
      yarn)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        yarn tauri build
        ;;
      npm)
        STELLAR_HELPER_BUILDING=1 \
        VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
        VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
        npm run tauri:build
        ;;
    esac
  fi
}

remove_path_if_exists() {
  local path="$1"
  if [[ -e "${path}" ]]; then
    rm -rf "${path}"
    echo "    removed ${path}"
  fi
}

wipe_app_data() {
  local home_dir="${HOME}"

  echo "==> Wiping local app data"

  remove_path_if_exists "${TMP_APP_DIR}"

  remove_path_if_exists "${home_dir}/.config/${APP_NAME}"
  remove_path_if_exists "${home_dir}/.cache/${APP_NAME}"
  remove_path_if_exists "${home_dir}/.local/share/${APP_NAME}"

  remove_path_if_exists "${home_dir}/.config/${APP_BIN_NAME}"
  remove_path_if_exists "${home_dir}/.cache/${APP_BIN_NAME}"
  remove_path_if_exists "${home_dir}/.local/share/${APP_BIN_NAME}"

  remove_path_if_exists "${home_dir}/.config/stellar-vpn"
  remove_path_if_exists "${home_dir}/.cache/stellar-vpn"
  remove_path_if_exists "${home_dir}/.local/share/stellar-vpn"

  remove_path_if_exists "${home_dir}/.config/com.stellarsecurity.vpn"
  remove_path_if_exists "${home_dir}/.cache/com.stellarsecurity.vpn"
  remove_path_if_exists "${home_dir}/.local/share/com.stellarsecurity.vpn"

  remove_path_if_exists "${home_dir}/.local/state/${APP_NAME}"
  remove_path_if_exists "${home_dir}/.local/state/${APP_BIN_NAME}"
  remove_path_if_exists "${home_dir}/.local/state/stellar-vpn"
}

find_appimage() {
  find "${APPIMAGE_DIR}" -maxdepth 1 -type f -name "*.AppImage" | head -n 1
}

echo "==> Repo root: ${REPO_ROOT}"
echo "==> Package manager: ${PM}"
echo "==> Build mode: ${BUILD_MODE}"
echo "==> VITE_SHOW_VPN_LOGS: ${VITE_SHOW_VPN_LOGS_VALUE}"
echo "==> VITE_OTA_TARGET: ${VITE_OTA_TARGET_VALUE}"
echo "==> Wipe data: ${WIPE_DATA}"
if [[ ${#TAURI_FEATURE_ARGS[@]} -gt 0 ]]; then
  echo "==> Tauri feature args: ${TAURI_FEATURE_ARGS[*]}"
else
  echo "==> Tauri feature args: none"
fi

echo "==> Requesting sudo access"
sudo -v

echo "==> Stopping old app/helper/VPN"
sudo pkill -f "${HELPER_BIN_NAME}" || true
sudo pkill -f openvpn || true
pkill -f "${APP_BIN_NAME}" || true
pkill -f "Stellar VPN" || true

echo "==> Removing old helper sockets"
sudo rm -f "${TMP_SOCKET_1}" || true
sudo rm -f "${TMP_SOCKET_2}" || true
rm -rf "${TMP_APP_DIR}" || true

if [[ "${WIPE_DATA}" == "true" ]]; then
  wipe_app_data
fi

echo "==> Cleaning previous Rust build output"
rm -rf "${REPO_ROOT}/src-tauri/target"
mkdir -p "${REPO_ROOT}/src-tauri/bin"

echo "==> Building privileged/helper binary"
cd "${REPO_ROOT}/src-tauri"

if [[ ${#CARGO_FEATURE_ARGS[@]} -gt 0 ]]; then
  STELLAR_HELPER_BUILDING=1 \
  VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
  VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
  cargo build --release --bin "${HELPER_BIN_NAME}" "${CARGO_FEATURE_ARGS[@]}"
else
  STELLAR_HELPER_BUILDING=1 \
  VITE_SHOW_VPN_LOGS="${VITE_SHOW_VPN_LOGS_VALUE}" \
  VITE_OTA_TARGET="${VITE_OTA_TARGET_VALUE}" \
  cargo build --release --bin "${HELPER_BIN_NAME}"
fi

cp -f "target/release/${HELPER_BIN_NAME}" "bin/${HELPER_BIN_NAME}"
ls -l "bin/${HELPER_BIN_NAME}"

echo "==> Installing helper to ${SYSTEM_HELPER_PATH}"
sudo mkdir -p "$(dirname "${SYSTEM_HELPER_PATH}")"
sudo cp -f "${HELPER_OUT}" "${SYSTEM_HELPER_PATH}"
sudo chown root:root "${SYSTEM_HELPER_PATH}"
sudo chmod 755 "${SYSTEM_HELPER_PATH}"

echo "==> Building app bundle"
cd "${REPO_ROOT}"
run_tauri_build

APPIMAGE_PATH="$(find_appimage)"

if [[ -z "${APPIMAGE_PATH}" || ! -f "${APPIMAGE_PATH}" ]]; then
  echo "Error: AppImage not found in ${APPIMAGE_DIR}" >&2
  exit 1
fi

chmod +x "${APPIMAGE_PATH}"

echo "==> Built AppImage"
echo "    ${APPIMAGE_PATH}"

if [[ "${OPEN_AFTER_BUILD}" == "true" ]]; then
  echo "==> Launching AppImage"
  nohup "${APPIMAGE_PATH}" >/tmp/stellar-vpn-appimage.log 2>&1 &
  disown || true
fi

echo "OK, Stellar VPN."