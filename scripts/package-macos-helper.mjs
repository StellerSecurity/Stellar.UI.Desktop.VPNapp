// First-party local test installer. No downloads, package scripts or signing-key access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Reviewed runtime is macOS ARM64 only.');
const runtime = path.resolve('src-tauri/resources/openvpn-runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
const files = ['openvpn', 'libcrypto.4.dylib', 'libssl.4.dylib', 'liblzo2.2.dylib', 'libpkcs11-helper.1.dylib', 'liblz4.1.dylib'];
if (manifest.platform !== 'darwin-arm64' || manifest.files.length !== files.length) throw new Error('Unexpected runtime.');
function regular(file) { if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular file: ${file}`); }
for (const file of files) {
  const input = path.join(runtime, file); regular(input);
  const actual = createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  if (manifest.files.find(row => row.file === file)?.sha256 !== actual) throw new Error(`Runtime hash mismatch: ${file}`);
}
const helper = path.resolve('target/debug/stellar-vpn-helper'); regular(helper);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-helper-installer-'));
const root = path.join(stage, 'root');
const destination = path.join(root, 'Library/Application Support/Stellar VPN');
fs.mkdirSync(path.join(destination, 'Runtime'), { recursive: true, mode: 0o755 });
function copy(input, output, mode) { regular(input); fs.copyFileSync(input, output); fs.chmodSync(output, mode); }
for (const file of [...files, 'runtime-manifest.json']) copy(path.join(runtime, file), path.join(destination, 'Runtime', file), file === 'runtime-manifest.json' ? 0o644 : 0o755);
copy(helper, path.join(destination, 'stellar-vpn-helper'), 0o755);
copy('scripts/macos-helper/uninstall', path.join(destination, 'uninstall-helper'), 0o755);
const scripts = path.join(stage, 'scripts'); fs.mkdirSync(scripts);
for (const script of ['preinstall', 'postinstall']) copy(`scripts/macos-helper/${script}`, path.join(scripts, script), 0o755);
const output = path.join(stage, 'Stellar-VPN-System-Helper.pkg');
const result = spawnSync('/usr/bin/pkgbuild', ['--root', root, '--scripts', scripts, '--identifier', 'org.stellarvpn.desktop.helper',
  '--version', '0.1.0', '--ownership', 'recommended', '--install-location', '/', output], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Installer packaging failed.');
console.log(JSON.stringify({ installer: output, sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
  installed: false, note: 'Local test package. Starts a persistent root helper; macOS administrator approval is required. Not a signed public release.' }, null, 2));
