import assert from 'node:assert/strict';
import test from 'node:test';
import {checkStagingLock} from '../../scripts/check-staging-lock.mjs';

const oldPackage = {name: 'example/library', version: '1.0.0', type: 'library'};
const candidate = {name: 'example/library', version: '1.0.1', repository: 'https://github.com/example/library.git', reference: 'abc123'};
const newPackage = {...oldPackage, version: candidate.version, source: {url: candidate.repository, reference: candidate.reference},
  dist: {type: 'zip', reference: candidate.reference, url: 'https://api.github.com/repos/example/library/zipball/abc123'}};
const lock = p => ({packages: [p], 'packages-dev': [], 'plugin-api-version': '2.6.0'});

test('accepts only the exact reviewed source/version/archive tuple', () => {
  assert.deepEqual(checkStagingLock(lock(oldPackage), lock(newPackage), [candidate]), []);
});
test('rejects an unexpected version or changed commit', () => {
  assert.ok(checkStagingLock(lock(oldPackage), lock({...newPackage, version: '9.0.0'}), [candidate]).length);
  assert.ok(checkStagingLock(lock(oldPackage), lock({...newPackage, source: {...newPackage.source, reference: 'different'}}), [candidate]).length);
});
test('rejects an unapproved transitive package and metadata changes', () => {
  const proposed = lock(newPackage); proposed.packages.push({name: 'extra/library', version: '1.0.0'});
  assert.ok(checkStagingLock(lock(oldPackage), proposed, [candidate]).some(e => e.startsWith('New package:')));
  const untouched = {name: 'untouched/library', version: '1.0.0'};
  const before = lock(oldPackage); before.packages.push(untouched);
  const after = lock(newPackage); after.packages.push({...untouched, version: '1.0.1'});
  assert.ok(checkStagingLock(before, after, [candidate]).some(e => e.startsWith('Unapproved change:')));
});
test('rejects new autoloaded code, plugins, alternate downloads and lock settings', () => {
  for (const patch of [{autoload: {files: ['payload.php']}}, {type: 'composer-plugin'}, {dist: {...newPackage.dist, url: 'https://unexpected.invalid/archive.zip'}}]) {
    assert.ok(checkStagingLock(lock(oldPackage), lock({...newPackage, ...patch}), [candidate]).length);
  }
  const proposed = lock(newPackage); proposed.platform = {php: '9.0.0'};
  assert.ok(checkStagingLock(lock(oldPackage), proposed, [candidate]).some(e => e.startsWith('Unapproved lock setting:')));
});
test('rejects duplicate package entries and moves between runtime and dev', () => {
  const duplicate = lock(newPackage); duplicate.packages.push(newPackage);
  assert.ok(checkStagingLock(lock(oldPackage), duplicate, [candidate]).length);
  const moved = {packages: [], 'packages-dev': [newPackage], 'plugin-api-version': '2.6.0'};
  assert.ok(checkStagingLock(lock(oldPackage), moved, [candidate]).length);
});
test('accepts only an explicitly approved writer-metadata transition', () => {
  const proposed = {...lock(newPackage), 'plugin-api-version': '2.9.0'};
  const exceptions = {'plugin-api-version': {before: '2.6.0', after: '2.9.0'}};
  assert.ok(checkStagingLock(lock(oldPackage), proposed, [candidate]).length);
  assert.deepEqual(checkStagingLock(lock(oldPackage), proposed, [candidate], exceptions), []);
  assert.ok(checkStagingLock(lock(oldPackage), {...proposed, 'plugin-api-version': '3.0.0'}, [candidate], exceptions).length);
  assert.ok(checkStagingLock({...lock(oldPackage), 'plugin-api-version': '2.5.0'}, proposed, [candidate], exceptions).length);
  assert.ok(checkStagingLock(lock(oldPackage), {...proposed, platform: {php: '9.0.0'}}, [candidate], exceptions).length);
});
