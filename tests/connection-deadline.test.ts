import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionDeadline } from '../src/application/ConnectionDeadline.ts';

test('configuration loading and native connect share one 30 second budget', () => {
  let now = 100;
  const deadline = new ConnectionDeadline(() => now);
  assert.equal(deadline.remaining(), 30_000);
  now += 12_000;
  assert.equal(deadline.remaining(), 18_000);
  now += 17_999;
  assert.equal(deadline.remaining(), 1);
  now += 1;
  assert.throws(() => deadline.remaining(), /timed out/);
});

test('late configuration responses cannot start a new native attempt', () => {
  let now = 0;
  const deadline = new ConnectionDeadline(() => now);
  now = 30_001;
  assert.throws(() => deadline.remaining(), /timed out/);
});
