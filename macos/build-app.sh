#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_root=${script_dir:h}
build_dir="$project_root/build"
app_bundle="$project_root/dist/Stellar VPN.app"
contents_dir="$app_bundle/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
web_dir="$resources_dir/Web"
module_cache="$build_dir/ModuleCache"

mkdir -p "$macos_dir" "$web_dir/assets" "$module_cache"

/usr/bin/clang \
  -fobjc-arc \
  -fmodules-cache-path="$module_cache" \
  -mmacosx-version-min=13.0 \
  "$script_dir/StellarVPNApp.m" \
  -framework Cocoa \
  -framework WebKit \
  -o "$macos_dir/StellarVPN"

/bin/cp "$script_dir/Info.plist" "$contents_dir/Info.plist"
/bin/cp "$project_root/legacy/index.html" "$web_dir/index.html"
/bin/cp "$project_root/stellar-tokens.css" "$web_dir/stellar-tokens.css"
/bin/cp "$project_root/vpn.css" "$web_dir/vpn.css"
/bin/cp "$project_root/legacy/vpn.js" "$web_dir/vpn.js"
/bin/cp "$project_root/assets/europe-map.svg" "$web_dir/assets/europe-map.svg"
/bin/cp "$project_root/assets/servers.json" "$web_dir/assets/servers.json"
/bin/cp "$project_root/assets/stellar-vpn-logo.png" "$web_dir/assets/stellar-vpn-logo.png"
/bin/cp "$project_root/assets/world-countries.geojson" "$web_dir/assets/world-countries.geojson"

/usr/bin/sips -c 128 128 --cropOffset 0 -10 "$project_root/assets/stellar-vpn-logo.png" --out "$build_dir/AppIcon-source.png" >/dev/null
/usr/bin/sips -z 512 512 "$build_dir/AppIcon-source.png" --out "$resources_dir/AppIcon.png" >/dev/null

/usr/bin/codesign --force --deep --sign - "$app_bundle"
/usr/bin/codesign --verify --deep --strict "$app_bundle"

echo "$app_bundle"
