// Public release material only. Never loads a private key, signs, uploads or
// installs anything. Sign externally with the existing Tauri CLI --app-version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, verify } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trust = fs.readFileSync(path.join(root, 'src-tauri/src/updates/trust.rs'), 'utf8');
export const PINNED_PUBLIC_KEY = /pub const PUBLIC_KEY: &str = "([^"]+)"/.exec(trust)?.[1];
if (!PINNED_PUBLIC_KEY) throw new Error('Pinned OTA public key is missing.');
export function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.split('.').some(n => Number(n) > 0xffffffff)) throw new Error('A canonical stable version is required.');
  return version;
}
export function verifyRelease(bytes, input, version, publicKey) {
  stableVersion(version);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 512 * 1024 * 1024 || typeof input !== 'string' || input.length > 4096) throw new Error('Invalid release material.');
  const decoded = input.startsWith('untrusted comment: ') ? input : Buffer.from(input.trim(), 'base64').toString('utf8');
  const lines = decoded.trimEnd().split('\n');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid Minisign format.');
  const key = Buffer.from(publicKey, 'base64'), signature = Buffer.from(lines[1], 'base64'), global = Buffer.from(lines[3], 'base64');
  if (key.length !== 42 || signature.length !== 74 || global.length !== 64 || signature.subarray(0, 2).toString() !== 'ED' || !key.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error('Unexpected signing key or algorithm.');
  const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const comment = lines[2].slice(17);
  const payloadSignature = signature.subarray(10);
  if (!verify(null, createHash('blake2b512').update(bytes).digest(), publicObject, payloadSignature)
    || !verify(null, Buffer.concat([payloadSignature, Buffer.from(comment)]), publicObject, global)) throw new Error('Release signature rejected.');
  const versions = comment.split('\t').filter(s => s.startsWith('version:')).map(s => s.slice(8));
  if (versions.length !== 1 || versions[0] !== version) throw new Error('Signed version does not match the release version.');
  return Buffer.from(decoded.trimEnd()).toString('base64');
}
export function createManifest(bytes, signatureText, version, target) {
  stableVersion(version);
  if (!['darwin-aarch64', 'darwin-x86_64'].includes(target)) throw new Error('Only reviewed macOS OTA targets are supported.');
  const signature = verifyRelease(bytes, signatureText, version, PINNED_PUBLIC_KEY);
  return { version, notes: `Stellar VPN ${version}`, platforms: { [target]: { url: `https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/${version}/${target}/Stellar%20VPN.app.tar.gz`, signature } } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifact, signaturePath, version, target, ...extra] = process.argv.slice(2);
  if (!artifact || !signaturePath || !version || !target || extra.length || !artifact.endsWith('.app.tar.gz') || !signaturePath.endsWith('.sig')) throw new Error('Usage: node scripts/prepare-ota-manifest.mjs ARTIFACT.app.tar.gz SIGNATURE.sig VERSION darwin-aarch64|darwin-x86_64');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  if (config.version !== version || packageJson.version !== version || /\nversion = "([^"]+)"/.exec(cargo)?.[1] !== version) throw new Error('App, package, Cargo and release versions must match.');
  const size = fs.lstatSync(artifact), sigSize = fs.lstatSync(signaturePath);
  if (!size.isFile() || size.size > 512 * 1024 * 1024 || !sigSize.isFile() || sigSize.size > 4096) throw new Error('Invalid release files.');
  const manifest = createManifest(fs.readFileSync(artifact), fs.readFileSync(signaturePath, 'utf8'), version, target);
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
