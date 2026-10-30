import test from 'node:test';
import assert from 'node:assert/strict';
import { markerAction } from '../src/features/map/domain/MarkerAction.ts';
const ids = ['ru-1', 'de-1'];
test('clicking an available marker connects when disconnected, including the selected marker', () => {
  assert.equal(markerAction('ru-1', ids, { status: 'disconnected', serverId: null, connectedAt: null }, false), 'connect');
});
test('clicking another marker switches the actual connection, not just the selected state', () => {
  assert.equal(markerAction('ru-1', ids, { status: 'connected', serverId: 'de-1', connectedAt: 1 }, false), 'connect');
});
test('the active marker does not reconnect an already established tunnel', () => {
  assert.equal(markerAction('de-1', ids, { status: 'connected', serverId: 'de-1', connectedAt: 1 }, false), 'select');
});
test('busy and unavailable markers cannot queue connection attempts', () => {
  assert.equal(markerAction('ru-1', ids, undefined, true), 'ignore');
  assert.equal(markerAction('unknown', ids, undefined, false), 'ignore');
});
