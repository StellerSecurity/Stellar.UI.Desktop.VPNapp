import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUpdate, mayInstall } from '../src/features/updates/domain/Update.ts';
const ready = { phase: 'ready' as const, currentVersion: '0.1.0', version: '1.2.3', notes: '', downloaded: 100, message: '' };
test('only a verified ready update with explicitly disconnected and unblocked VPN can install', () => {
  assert.equal(mayInstall(ready, 'disconnected', false, false), true);
  for (const status of ['connected', 'connecting', undefined]) assert.equal(mayInstall(ready, status, false, false), false);
  assert.equal(mayInstall(ready, 'disconnected', true, false), false);
  assert.equal(mayInstall(ready, 'disconnected', false, true), false);
  assert.equal(mayInstall({ ...ready, phase: 'available' }, 'disconnected', false, false), false);
});
test('update IPC rejects oversized, malformed and false-ready data', () => {
  assert.deepEqual(decodeUpdate(ready), ready);
  for (const bad of [null, {}, { ...ready, phase: 'verified-by-server' }, { ...ready, downloaded: -1 }, { ...ready, downloaded: NaN }, { ...ready, downloaded: 2 ** 32 }, { ...ready, version: {} }, { ...ready, version: null }, { ...ready, notes: 'x'.repeat(8193) }]) assert.throws(() => decodeUpdate(bad));
});
