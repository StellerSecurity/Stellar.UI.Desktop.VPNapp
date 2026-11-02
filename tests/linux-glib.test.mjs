import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLinuxGlib } from '../scripts/check-linux-glib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-glib-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'vendor'), path.join(directory, 'vendor'), { recursive: true });
  for (const file of ['Cargo.toml', 'Cargo.lock']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  return directory;
}

test('reviewed glib backport and local resolution pass integrity verification', () => {
  const evidence = verifyLinuxGlib(root);
  assert.equal(evidence.nativeLinuxVerification, 'pending');
  assert.ok(evidence.verifiedArchiveFiles > 100);
});

test('reverting the vulnerable pointer change fails closed', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'vendor/glib-0.18.5/src/variant_iter.rs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('&mut p,', '&p,'));
  assert.throws(() => verifyLinuxGlib(directory), /integrity mismatch/);
});

test('returning to a registry glib resolution fails closed', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'Cargo.lock');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name = "glib"\nversion = "0.18.5"', 'name = "glib"\nversion = "0.18.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"'));
  assert.throws(() => verifyLinuxGlib(directory), /exclusively to the local backport/);
});

test('removing the workspace override fails closed', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'Cargo.toml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('glib = { path = "vendor/glib-0.18.5" }', ''));
  assert.throws(() => verifyLinuxGlib(directory), /select the reviewed local/);
});

test('unreviewed extra source files fail closed', t => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'vendor/glib-0.18.5/build.rs'), 'fn main() {}');
  assert.throws(() => verifyLinuxGlib(directory), /Unreviewed glib file/);
});
