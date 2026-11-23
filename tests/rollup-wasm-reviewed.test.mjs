import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'vendor', 'rollup-wasm-reviewed');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

test('Rollup resolves to the reviewed WASM package without native optional packages', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const vendored = JSON.parse(await readFile(path.join(vendorRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.devDependencies.rollup, 'file:vendor/rollup-wasm-reviewed');
  assert.equal(manifest.overrides.rollup, '$rollup');
  assert.equal(lock.packages[''].devDependencies.rollup, 'file:vendor/rollup-wasm-reviewed');
  assert.deepEqual(lock.packages['node_modules/rollup'], {
    version: '4.65.1-stellar.1',
    resolved: 'file:vendor/rollup-wasm-reviewed',
    dev: true,
    license: 'MIT',
    dependencies: { '@types/estree': '1.0.9' },
    bin: { rollup: 'dist/bin/rollup' },
    engines: { node: '>=22.12.0' },
  });
  assert.equal(vendored.name, 'rollup');
  assert.equal(vendored.version, '4.65.1-stellar.1');
  assert.equal(vendored.scripts, undefined);
  assert.equal(vendored.optionalDependencies, undefined);
  assert.equal(vendored.devDependencies, undefined);

  const forbidden = Object.keys(lock.packages).filter((entry) => (
    entry.startsWith('node_modules/@rollup/rollup-')
      || entry === 'node_modules/@napi-rs/lzma-linux-x64-gnu'
  ));
  assert.deepEqual(forbidden, []);
});

test('reviewed Rollup package matches its exact attested inventory', async () => {
  const provenance = JSON.parse(await readFile(path.join(vendorRoot, 'stellar-patch.json'), 'utf8'));
  assert.equal(provenance.upstream.name, '@rollup/wasm-node');
  assert.equal(provenance.upstream.version, '4.65.1');
  assert.equal(provenance.upstream.npm_archive_sha256, '8fd2e64dfeaa6334a683ce198e4b6487df44c63f02f3b7843339300b3e5f459a');
  assert.equal(provenance.upstream.release_commit, '7879c65994dd591d287b177b8d0b88d7d76c2a49');
  assert.equal(provenance.review.osv_matches, 0);
  assert.equal(provenance.review.github_advisory_matches, 0);
  assert.equal(provenance.review.provenance_verified, true);
  assert.equal(provenance.review.wasm_type_validation, true);
  assert.equal(provenance.review.parser_regression_assertions, 16);
  assert.equal(provenance.review.network_allowed_during_parser_tests, false);

  const actualPaths = (await filesUnder(vendorRoot))
    .map((file) => path.relative(vendorRoot, file).split(path.sep).join('/'))
    .filter((file) => file !== 'stellar-patch.json')
    .sort();
  assert.deepEqual(actualPaths, Object.keys(provenance.files).sort());

  for (const relative of actualPaths) {
    const target = path.join(vendorRoot, relative);
    const content = await readFile(target);
    const metadata = await stat(target);
    assert.equal(metadata.size, provenance.files[relative].bytes, `${relative} size changed`);
    assert.equal(
      createHash('sha256').update(content).digest('hex'),
      provenance.files[relative].sha256,
      `${relative} hash changed`,
    );
  }

  assert.deepEqual(provenance.files['dist/wasm-node/bindings_wasm_bg.wasm'], {
    sha256: '7099c59e9da5c0d690356ba986bf02a89dd21b35e578684758ecbdac4aca0c8d',
    bytes: 588077,
  });
});
