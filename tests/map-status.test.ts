import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus } from '../src/features/map/domain/MapStatus.ts';

test('a selected location or stale server ID never proves a connection', () => {
  assert.deepEqual(mapStatus(undefined, false), { connected: false, securedServerId: null });
  assert.deepEqual(mapStatus({ status: 'disconnected', serverId: 'ru-1', connectedAt: 100 }, false), { connected: false, securedServerId: null });
});
test('connecting, switching and disconnecting never display a green secured marker', () => {
  assert.deepEqual(mapStatus({ status: 'connected', serverId: 'de-1', connectedAt: 100 }, true), { connected: false, securedServerId: null });
});
test('only the confirmed tunnel server is green, not the latest selected location', () => {
  assert.deepEqual(mapStatus({ status: 'connected', serverId: 'de-1', connectedAt: 100 }, false), { connected: true, securedServerId: 'de-1' });
});
test('a malformed connected snapshot without a server cannot show protection', () => {
  assert.deepEqual(mapStatus({ status: 'connected', serverId: null, connectedAt: 100 }, false), { connected: false, securedServerId: null });
});
