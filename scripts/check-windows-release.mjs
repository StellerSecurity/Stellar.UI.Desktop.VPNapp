// Read-only gate. No installation, download, driver registration or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function windowsSourceHash(directory = root) {
  const walk = relative => fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Source symlinks are not accepted.');
    const name = relative + '/' + entry.name;
    return entry.isDirectory() ? walk(name) : [name];
  });
  const names = [...walk('native/windows'), ...walk('src-tauri/src'), ...walk('crates/stellar-core/src'), ...walk('src'),
    'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/legacy-migration.json',
    'src-tauri/build.rs', 'Cargo.lock', 'package-lock.json', 'scripts/desktop.mjs', 'scripts/check-windows-release.mjs',
    'scripts/windows-native-compile.ps1', 'scripts/build-windows-helper.mjs'].sort();
  const hash = createHash('sha256');
  for (const name of names) { hash.update(name + '\0'); hash.update(fs.readFileSync(path.join(directory, name))); }
  return hash.digest('hex');
}
export function verifyWindowsRelease(directory = root) {
  const policy = JSON.parse(fs.readFileSync(path.join(directory, 'native/windows/release-policy.json'), 'utf8'));
  if (policy.schema !== 1 || policy.releaseReady !== true || policy.runtimeApproved !== true || policy.driverApproved !== true || policy.servicePersistenceApproved !== true) {
    throw new Error('Windows distribution is blocked until the exact runtime/driver review, installer-managed service approval and native acceptance are complete.');
  }
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, '.security-review/windows-acceptance.json'), 'utf8'));
  if (evidence.sourceSha256 !== windowsSourceHash(directory) || !policy.requiredAcceptance.every(name => evidence.tests?.[name] === 'passed')) {
    throw new Error('Windows native acceptance is missing, failed or stale for these exact sources.');
  }
  if (!policy.architectures.includes(evidence.architecture) || !/^[a-f0-9]{64}$/.test(evidence.runtimeManifestSha256 ?? '')) throw new Error('Unreviewed Windows architecture/runtime.');
  const runtime = path.join(directory, 'src-tauri/resources/windows/Runtime/runtime.sha256');
  if (createHash('sha256').update(fs.readFileSync(runtime)).digest('hex') !== evidence.runtimeManifestSha256) throw new Error('Windows runtime changed after acceptance.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyWindowsRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
