import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyLinuxGlib } from './check-linux-glib.mjs';
const args = process.argv.slice(2);
// Local test builds keep one certificate-backed identity across rebuilds.
// Only a public fingerprint is stored here; keys stay in the macOS Keychain.
const signingConfig = path.resolve('.security-review/local-signing.json');
let localIdentity;
if (process.platform === 'darwin' && args[0] === 'build' && args.includes('--debug') && fs.existsSync(signingConfig)) {
  localIdentity = JSON.parse(fs.readFileSync(signingConfig, 'utf8')).identity;
  if (typeof localIdentity !== 'string' || !/^[A-F0-9]{40}$/.test(localIdentity)) throw new Error('Invalid local signing fingerprint.');
  if (!args.includes('--no-sign')) args.push('--no-sign');
  console.log('Local development signing enabled after bundling; --no-sign applies only to the Tauri bundling step.');
}
verifyLinuxGlib();
if (process.platform === 'linux' && args[0] === 'build') {
  console.error('Linux release remains blocked until the local glib security backport passes native Linux debug/release regression tests and the desktop build. See vendor/glib-0.18.5/stellar-backport.json.');
  process.exit(1);
}
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env };
if (fs.existsSync(cargoBin)) env.PATH = cargoBin + path.delimiter + (env.PATH || '');
const cli = path.resolve('node_modules/@tauri-apps/cli/tauri.js');
if (!fs.existsSync(cli)) throw new Error('Tauri CLI is missing. Install the reviewed lockfile first.');
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  if (code !== 0 || !localIdentity) { process.exitCode = code ?? 1; return; }
  const bundle = path.resolve('target/debug/bundle/macos/Stellar VPN.app');
  for (const options of [
    ['--force', '--sign', localIdentity, '--identifier', 'org.stellarvpn.desktop.preview', '--timestamp=none', bundle],
    ['--verify', '--strict', '--verbose=2', bundle],
  ]) {
    const result = spawnSync('/usr/bin/codesign', options, { stdio: 'inherit' });
    if (result.error || result.status !== 0) { console.error('Local signing failed; do not launch an unsigned fallback.'); process.exitCode = 1; return; }
  }
  console.log('Stellar VPN test bundle signed and verified with the fixed local certificate.');
});
