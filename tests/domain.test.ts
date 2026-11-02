import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServers, filterServers } from '../src/features/locations/domain/Server.ts';
import { validateAuth } from '../src/features/auth/domain/Auth.ts';
import { elapsedTime } from '../src/features/connection/domain/Connection.ts';
import { daysRemaining } from '../src/features/account/domain/Account.ts';
import { ConnectionService } from '../src/features/connection/application/ConnectionService.ts';
import { decodeSnapshot } from '../src/infrastructure/tauri/decodeSnapshot.ts';
import { defaultSettings } from '../src/contracts/desktop.ts';
import { mapPoint, routeCurve } from '../src/features/map/domain/geometry.ts';
test('location switch route starts and ends at the actual server markers', () => {
  const from = { lon: 12.57, lat: 55.68 }, to = { lon: 18.06, lat: 59.33 };
  const start = mapPoint(from), end = mapPoint(to);
  const curve = routeCurve(from, to);
  assert.ok(curve.startsWith(`M${start.x} ${start.y} Q`));
  assert.ok(curve.endsWith(`${end.x} ${end.y}`));
  assert.ok(!/NaN|Infinity/.test(curve));
  assert.ok(!/NaN|Infinity/.test(routeCurve(from, from)));
  assert.notEqual(curve, routeCurve(to, from));
});
test('rejects invalid coordinates and duplicate server identities at the adapter boundary', () => {
  const raw = { id: 'dk-1', name: 'Denmark – Copenhagen', country: 'DK', lat: 55.6, lon: 12.5 };
  assert.equal(normalizeServers([raw])[0].city, 'Copenhagen');
  assert.throws(() => normalizeServers([{ ...raw, lat: 91 }]));
  assert.throws(() => normalizeServers([raw, raw]));
  assert.equal(filterServers(normalizeServers([raw]), '  COPENHAGEN ', null).length, 1);
  assert.equal(filterServers(normalizeServers([raw]), '', []).length, 0);
});
test('country-code search follows the live catalog, ignores case and respects favorites', () => {
  const servers = normalizeServers([
    { id: 'dk-1', name: 'Denmark – Copenhagen', country: 'DK', lat: 55, lon: 12 },
    { id: 'se-1', name: 'Sweden – Stockholm', country: 'SE', lat: 59, lon: 18 },
    { id: 'se-2', name: 'Sweden – Gothenburg', country: 'SE', lat: 57, lon: 11 },
    { id: 'sc-1', name: 'Seychelles – Victoria', country: 'SC', lat: -4, lon: 55 },
    { id: 'bt-new', name: 'Bhutan – Thimphu', country: 'BT', lat: 27, lon: 89 },
  ]);
  const ids = (query: string, favorites: string[] | null = null) => filterServers(servers, query, favorites).map(server => server.id);
  assert.deepEqual(ids(' DK '), ['dk-1']);
  assert.deepEqual(ids('sE'), ['se-2', 'se-1']);
  assert.deepEqual(ids('bt'), ['bt-new']);
  assert.deepEqual(ids('SE', ['se-1']), ['se-1']);
  assert.deepEqual(ids('DK', ['se-1']), []);
  assert.deepEqual(ids('denmark'), ['dk-1']);
  assert.deepEqual(ids('stock'), ['se-1']);
  assert.deepEqual(ids('zz'), []);
  assert.equal(ids('').length, servers.length);
});
test('validates all authentication paths without storing credentials', () => {
  assert.ok(validateAuth('login', { email: 'bad', password: 'x' }));
  assert.equal(validateAuth('login', { email: 'demo@example.com', password: 'test' }), null);
  assert.ok(validateAuth('register', { email: 'demo@example.com', password: '12345' }));
  assert.equal(validateAuth('register', { email: 'demo@example.com', password: '123456' }), null);
  assert.ok(validateAuth('account', { account: '123' }));
  assert.equal(validateAuth('account', { account: '1234 5678 9012 3456' }), null);
});
test('subscription and connection clocks never show negative durations', () => {
  assert.equal(daysRemaining('2026-11-20T00:00:00Z', Date.parse('2026-11-19T12:00:00Z')), 1);
  assert.equal(daysRemaining('2026-11-20T00:00:00Z', Date.parse('2026-11-21T00:00:00Z')), 0);
  assert.equal(elapsedTime(100_000, 99_000), '00:00:00');
  assert.equal(elapsedTime(0, 3_661_000), '01:01:01');
});
test('connection service serializes commands and discards stale results', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const service = new ConnectionService({
    async connect(id) { calls.push(id); await gate; return { status: 'connected', serverId: id, connectedAt: 1 }; },
    async disconnect() { calls.push('disconnect'); return { status: 'disconnected', serverId: null, connectedAt: null }; }
  });
  const first = service.connect('dk-1'); const second = service.disconnect();
  await Promise.resolve(); assert.deepEqual(calls, ['dk-1']); release();
  assert.equal((await first).current, false); assert.equal((await second).current, true);
  assert.deepEqual(calls, ['dk-1', 'disconnect']);
});
test('a failed stale connection cannot cancel a newer disconnect', async () => {
  const service = new ConnectionService({
    async connect() { throw new Error('Old network request failed'); },
    async disconnect() { return { status: 'disconnected', serverId: null, connectedAt: null }; }
  });
  const old = service.connect('dk-1'), current = service.disconnect();
  assert.equal((await old).current, false);
  assert.equal((await current).current, true);
});
test('IPC boundary rejects an incompatible version and malformed native data', () => {
  const state = { contractVersion: 1, runtime: 'native-preview', connection: { status: 'disconnected', serverId: null, connectedAt: null }, settings: defaultSettings, session: { authenticated: false, onboardingComplete: false } };
  assert.equal(decodeSnapshot(state).contractVersion, 1);
  assert.throws(() => decodeSnapshot({ ...state, contractVersion: 2 }));
  assert.throws(() => decodeSnapshot({ ...state, settings: { ...defaultSettings, killSwitch: 'true' } }));
  for (const invalid of [-1, Infinity, '1.2']) {
    assert.throws(() => decodeSnapshot({ ...state, connection: { ...state.connection, downloadMbps: invalid } }));
  }
  assert.equal(decodeSnapshot({ ...state, connection: { ...state.connection, downloadMbps: 62.0, uploadMbps: 2.0 } }).connection.downloadMbps, 62.0);
});
