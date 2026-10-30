import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionService } from '../src/features/connection/application/ConnectionService.ts';
import type { ConnectionSnapshot } from '../src/contracts/desktop.ts';

const stopped: ConnectionSnapshot = { status: 'disconnected', serverId: null, connectedAt: null, trafficBlocked: true };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
test('cancel bypasses blocked connect, preserves blocked snapshot and ignores late success', async () => {
  const pending = deferred<ConnectionSnapshot>();
  let disconnects = 0;
  const service = new ConnectionService({ connect: () => pending.promise, disconnect: async () => { disconnects++; return stopped; }, cancelConnect: async () => stopped });
  const connecting = service.connect('no-1');
  await Promise.resolve();
  assert.deepEqual(await service.cancelConnect(), { current: true, value: stopped });
  pending.resolve({ status: 'connected', serverId: 'no-1', connectedAt: 1 });
  assert.deepEqual(await connecting, { current: false, value: null });
  assert.equal(disconnects, 0, 'cancel must not disarm the firewall via ordinary disconnect');
});
test('new connect waits for old attempt and confirmed cancellation; late errors stay stale', async () => {
  const pending = deferred<ConnectionSnapshot>(), cancelling = deferred<ConnectionSnapshot>();
  const started: string[] = [];
  const service = new ConnectionService({ connect: id => { started.push(id); return id === 'no-1' ? pending.promise : Promise.resolve(stopped); }, disconnect: async () => stopped, cancelConnect: () => cancelling.promise });
  const first = service.connect('no-1'); await Promise.resolve();
  const cancel = service.cancelConnect();
  const second = service.connect('dk-1');
  cancelling.resolve(stopped); await cancel; await Promise.resolve();
  assert.deepEqual(started, ['no-1']);
  pending.reject(new Error('late error'));
  assert.equal((await first).current, false);
  assert.equal((await second).current, true);
  assert.deepEqual(started, ['no-1', 'dk-1']);
});
test('missing cancellation never falls back to ordinary disconnect', async () => {
  let disconnected = false;
  const service = new ConnectionService({ connect: async () => stopped, disconnect: async () => { disconnected = true; return stopped; } });
  await assert.rejects(service.cancelConnect(), /unavailable/);
  assert.equal(disconnected, false);
});
