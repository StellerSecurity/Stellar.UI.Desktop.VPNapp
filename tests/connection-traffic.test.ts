import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionTraffic, displayTrafficRate, emptyTraffic } from '../src/features/connection/domain/ConnectionTraffic.ts';

const tunnel = { status: 'connected' as const, serverId: 'dk-1', connectedAt: 123 };
test('missing first measurements have placeholders, never invented zero rates', () => {
  const rates = connectionTraffic(emptyTraffic, tunnel);
  assert.equal(displayTrafficRate(rates.download), '—');
  assert.equal(displayTrafficRate(rates.upload), '—');
});
test('intermittent or partial telemetry retains measurements for the same tunnel', () => {
  const measured = connectionTraffic(emptyTraffic, { ...tunnel, downloadMbps: 12.6, uploadMbps: 2.1 });
  assert.deepEqual(connectionTraffic(measured, tunnel), measured);
  const partial = connectionTraffic(measured, { ...tunnel, downloadMbps: 0, uploadMbps: null });
  assert.equal(displayTrafficRate(partial.download), '0.0');
  assert.equal(displayTrafficRate(partial.upload), '2.1');
  assert.deepEqual(connectionTraffic(measured, { ...tunnel, downloadMbps: NaN, uploadMbps: -1 }), measured);
});
test('old speeds cannot leak across a disconnect, server switch or reconnect', () => {
  const measured = connectionTraffic(emptyTraffic, { ...tunnel, downloadMbps: 12.6, uploadMbps: 2.1 });
  for (const next of [undefined, { ...tunnel, status: 'disconnected' as const }, { ...tunnel, serverId: 'se-1' }, { ...tunnel, connectedAt: 456 }]) {
    const rates = connectionTraffic(measured, next);
    assert.equal(rates.download, null);
    assert.equal(rates.upload, null);
  }
});
