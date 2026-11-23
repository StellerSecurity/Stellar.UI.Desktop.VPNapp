import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Rollup resolves to the reviewed WASM package without native optional packages', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));

  assert.equal(manifest.devDependencies.rollup, 'npm:@rollup/wasm-node@4.65.1');
  assert.equal(manifest.overrides.rollup, '$rollup');
  assert.equal(lock.packages[''].devDependencies.rollup, 'npm:@rollup/wasm-node@4.65.1');
  assert.deepEqual(lock.packages['node_modules/rollup'], {
    name: '@rollup/wasm-node',
    version: '4.65.1',
    resolved: 'https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.65.1.tgz',
    integrity: 'sha512-Be9x0pnFS91wtAslz0fx3HnLbqQuV4EF2XLemwjz8BGqLjMrw9tCzu7vIuWgpjCEsMQgMtZ1FIWHJxX95ZwBkw==',
    dev: true,
    license: 'MIT',
    dependencies: { '@types/estree': '1.0.9' },
    bin: { rollup: 'dist/bin/rollup' },
    engines: { node: '>=18.0.0', npm: '>=8.0.0' },
  });

  const forbidden = Object.keys(lock.packages).filter((entry) => (
    entry.startsWith('node_modules/@rollup/rollup-')
      || entry === 'node_modules/@napi-rs/lzma-linux-x64-gnu'
  ));
  assert.deepEqual(forbidden, []);
});
