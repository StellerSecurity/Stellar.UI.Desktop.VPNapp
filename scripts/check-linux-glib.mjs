import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

export function verifyLinuxGlib(root = defaultRoot) {
  const directory = path.join(root, 'vendor/glib-0.18.5');
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'stellar-backport.json'), 'utf8'));
  if (provenance.package !== 'glib' || provenance.version !== '0.18.5' || provenance.advisory !== 'RUSTSEC-2024-0429') {
    throw new Error('Unexpected glib backport identity');
  }
  function checkInventory(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`glib source must not be a symlink: ${relative}`);
      if (entry.isDirectory()) checkInventory(path.join(dir, entry.name), relative + '/');
      else if (relative !== 'stellar-backport.json' && !Object.hasOwn(provenance.files, relative)) {
        throw new Error(`Unreviewed glib file: ${relative}`);
      }
    }
  }
  checkInventory(directory);
  for (const [relative, expected] of Object.entries(provenance.files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe glib manifest path');
    const file = path.join(directory, relative);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`glib source must not be a symlink: ${relative}`);
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) throw new Error(`glib backport integrity mismatch: ${relative}`);
  }
  const workspace = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
  const patch = workspace.match(/^\[patch\.crates-io\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  if (!/^glib\s*=\s*\{\s*path\s*=\s*"vendor\/glib-0\.18\.5"\s*\}\s*$/m.test(patch)) {
    throw new Error('Workspace must select the reviewed local glib backport');
  }
  const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const entries = lock.split('[[package]]').filter(entry => /^name = "glib"$/m.test(entry));
  if (entries.length !== 1 || !/^version = "0\.18\.5"$/m.test(entries[0]) || /^(source|checksum) =/m.test(entries[0])) {
    throw new Error('Cargo.lock must resolve glib exclusively to the local backport');
  }
  const source = fs.readFileSync(path.join(directory, 'src/variant_iter.rs'), 'utf8');
  if (!source.includes('let mut p: *mut libc::c_char = std::ptr::null_mut();') || !source.includes('                &mut p,')) {
    throw new Error('VariantStrIter upstream out-pointer fix is missing');
  }
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLinuxGlib();
  console.log('Linux glib backport: provenance, source hashes, patch and lockfile verified. Native Linux regression tests are still required.');
}
