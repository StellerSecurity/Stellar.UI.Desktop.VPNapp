const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
  process.exit(0);
}

const root = path.resolve(__dirname, '..', '..');
const tauriDir = path.join(root, 'src-tauri');
const binDir = path.join(tauriDir, 'bin');
const helperTargetDir = path.join(tauriDir, 'target', 'windows-helper-release-build');
const builtHelper = path.join(helperTargetDir, 'release', 'stellar-vpn-helper-windows.exe');
const bundledHelper = path.join(binDir, 'stellar-vpn-helper-windows.exe');

fs.mkdirSync(binDir, { recursive: true });
if (!fs.existsSync(bundledHelper)) {
  fs.writeFileSync(bundledHelper, Buffer.alloc(0));
}

console.log('[Stellar VPN] Building Windows helper service for release...');
const build = spawnSync('cargo', ['build', '--release', '--target-dir', helperTargetDir, '--bin', 'stellar-vpn-helper-windows'], {
  cwd: tauriDir,
  stdio: 'inherit',
  windowsHide: false,
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(builtHelper, bundledHelper);
console.log(`[Stellar VPN] Bundled Windows helper: ${bundledHelper}`);
