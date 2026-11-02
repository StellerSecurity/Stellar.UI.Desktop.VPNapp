// First-party staging only. Never installs or starts the app or system helper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { binaryArchitectures } from './macos-architecture.mjs';
const source = path.resolve(process.argv[2] || 'target/debug/bundle/macos/Stellar VPN.app');
const executable = path.join(source, 'Contents/MacOS/stellar-vpn-desktop');
const identifier = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(source, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (identifier !== 'org.stellarsecurity.vpn.desktop') throw new Error('Unexpected app identity');
const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(source, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== JSON.parse(fs.readFileSync('package.json', 'utf8')).version) throw new Error('App and package versions must match');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash = sha256(executable);
const [architecture] = binaryArchitectures(executable);
const resources = path.join(source, 'Contents/Resources');
const helperMetadata = JSON.parse(fs.readFileSync(path.join(resources, 'NetworkHelper.arch.json'), 'utf8'));
if (helperMetadata.architecture !== architecture || helperMetadata.runtimePlatform !== `darwin-${architecture}`
  || helperMetadata.packageSha256 !== sha256(path.join(resources, 'NetworkHelper.pkg'))) throw new Error('Bundled helper/runtime architecture or integrity mismatch');
function validate(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Unexpected source symlink');
    if (item.isDirectory()) validate(path.join(directory, item.name));
  }
}
validate(source);
const working = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-drag-dmg-'));
const stage = path.join(working, 'contents'); fs.mkdirSync(stage);
fs.cpSync(source, path.join(stage, 'Stellar VPN.app'), { recursive: true });
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
if (sha256(path.join(stage, 'Stellar VPN.app/Contents/MacOS/stellar-vpn-desktop')) !== sourceHash) throw new Error('Staged app integrity mismatch');
fs.mkdirSync('build/installers', { recursive: true });
const output = fs.mkdtempSync(path.resolve('build/installers/stellar-drag-'));
const result = { source, sourceHash, appIdentifier: identifier, working, stage, workingDmg: path.join(working, 'working.dmg'), mountpoint: path.join(working, 'mounted'),
  dmg: path.join(output, `Stellar-VPN-${version}-macos-${architecture}-drag-to-Applications.dmg`), version, architecture, installed: false, developerIDSigned: false, notarised: false,
  contents: ['Stellar VPN.app', 'Applications → /Applications'],
  note: 'Drag the app to Applications. If the system helper is missing, the app can open its bundled helper installer only on explicit user action. macOS owns administrator approval.' };
fs.mkdirSync(result.mountpoint);
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
