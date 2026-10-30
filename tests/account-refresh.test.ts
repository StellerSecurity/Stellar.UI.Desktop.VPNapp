import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountRefresh, ACCOUNT_REFRESH_INTERVAL, CONNECTED_ACCOUNT_REFRESH_INTERVAL } from '../src/application/AccountRefresh.ts';
test('account refresh is due every four hours, without bursts after sleep', () => {
  const gate = new AccountRefresh(); gate.mark(0);
  assert.equal(ACCOUNT_REFRESH_INTERVAL, 14_400_000);
  assert.equal(gate.request(ACCOUNT_REFRESH_INTERVAL - 1, true), false);
  assert.equal(gate.request(ACCOUNT_REFRESH_INTERVAL, true), true);
  assert.equal(gate.request(ACCOUNT_REFRESH_INTERVAL + 1, true), false);
  assert.equal(gate.request(ACCOUNT_REFRESH_INTERVAL * 5, true), true);
  assert.equal(gate.request(ACCOUNT_REFRESH_INTERVAL * 5 + 1, true), false);
});
test('page open and resume refresh immediately but coalesce focus and visibility duplicates', () => {
  const gate = new AccountRefresh(); gate.mark(1000);
  assert.equal(gate.request(4000), true);
  assert.equal(gate.request(4001), false);
  assert.equal(gate.request(4002), false);
  assert.equal(gate.request(7000), true);
  assert.equal(gate.request(7001, true), false);
});
test('connected subscription checks wait thirty minutes; minute pulses do not request HTTP', () => {
  const gate = new AccountRefresh(); gate.mark(0);
  assert.equal(CONNECTED_ACCOUNT_REFRESH_INTERVAL, 1_800_000);
  for (let minute = 1; minute < 30; minute++) assert.equal(gate.request(minute * 60_000, true, CONNECTED_ACCOUNT_REFRESH_INTERVAL), false);
  assert.equal(gate.request(1_799_999, true, CONNECTED_ACCOUNT_REFRESH_INTERVAL), false);
  assert.equal(gate.request(1_800_000, true, CONNECTED_ACCOUNT_REFRESH_INTERVAL), true);
  assert.equal(gate.request(1_800_001, true, CONNECTED_ACCOUNT_REFRESH_INTERVAL), false);
  assert.equal(gate.request(1_800_002), false);
});
