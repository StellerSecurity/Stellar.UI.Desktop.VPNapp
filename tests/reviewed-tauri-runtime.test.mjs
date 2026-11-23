import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyReviewedTauriRuntime } from '../scripts/reviewed-tauri-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri native platform packages are absent from the repository dependency graph', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@tauri-apps/cli'], undefined);
  assert.equal(lock.packages[''].devDependencies['@tauri-apps/cli'], undefined);
  assert.deepEqual(
    Object.keys(lock.packages).filter((entry) => entry === 'node_modules/@tauri-apps/cli' || entry.startsWith('node_modules/@tauri-apps/cli-')),
    [],
  );
});

test('Tauri runtime manifest permits only exact official 2.12.4 host artifacts', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'vendor/tauri-cli-reviewed/runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.package_version, '2.12.4');
  assert.equal(manifest.source_commit, '993038c49185307dfc895ab7657d77ca0d5ed7c7');
  assert.equal(manifest.review.risk_classification, 'MEDIUM');
  assert.equal(manifest.review.native_code_semantic_review_complete, false);
  assert.equal(Object.keys(manifest.targets).length, 11);
  for (const [target, approved] of Object.entries(manifest.targets)) {
    assert.match(target, /^(darwin|linux|win32)-/);
    assert.match(approved.package, /^@tauri-apps\/cli-/);
    assert.match(approved.url, /^https:\/\/registry\.npmjs\.org\/@tauri-apps\/cli-/);
    assert.match(approved.integrity, /^sha512-/);
    assert.match(approved.archive_sha256, /^[a-f0-9]{64}$/);
    assert.match(approved.sha256, /^[a-f0-9]{64}$/);
    assert.ok(approved.bytes > 10_000_000 && approved.bytes < 21_000_000);
    assert.equal(path.basename(approved.member), approved.filename);
  }
});

test('runtime verification rejects changed size, bytes and symbolic links', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stellar-tauri-runtime-'));
  const runtime = path.join(directory, 'fixture.node');
  const bytes = Buffer.from('first-party synthetic runtime fixture');
  const approved = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(runtime, bytes);
  assert.doesNotThrow(() => verifyReviewedTauriRuntime(runtime, approved));
  await writeFile(runtime, Buffer.from('changed synthetic runtime fixture'));
  assert.throws(() => verifyReviewedTauriRuntime(runtime, approved), /missing or has changed|hash does not match/);
  await writeFile(runtime, bytes);
  const runtimeLink = path.join(directory, 'fixture-link.node');
  await symlink(runtime, runtimeLink);
  assert.throws(() => verifyReviewedTauriRuntime(runtimeLink, approved), /missing or has changed|regular non-symbolic file/);
});

test('provisioning is separate, explicit and cannot run package lifecycle hooks', async () => {
  const provisioner = await readFile(path.join(root, 'scripts/provision-reviewed-tauri.py'), 'utf8');
  const desktop = await readFile(path.join(root, 'scripts/desktop.mjs'), 'utf8');
  assert.match(provisioner, /--approve-reviewed-download/);
  assert.match(provisioner, /registry\.npmjs\.org\/\@tauri-apps\/cli-/);
  assert.match(provisioner, /archive_sha256/);
  assert.doesNotMatch(provisioner, /subprocess|os\.system|shell=True|npm\s+(?:ci|exec|install)|npx\s/);
  assert.match(desktop, /runReviewedTauri/);
  assert.doesNotMatch(desktop, /node_modules\/\@tauri-apps\/cli/);
  assert.doesNotMatch(desktop, /provision-reviewed-tauri/);
});
