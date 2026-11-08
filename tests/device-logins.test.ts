import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient, SessionChanged } from '../src/infrastructure/auth/HttpIdentityClient.ts';
import { deviceLoginsPage } from '../src/features/devices/domain/DeviceSession.ts';
const token = '42|' + 'a'.repeat(40), id = 'd1' + 'b'.repeat(32), otherId = 'd1' + 'c'.repeat(32);
const root = id + '|' + 'd'.repeat(64);
const row = { id, current: true, revoked: false, created_at: '2026-11-08T00:00:00Z' };
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { headers: { 'Content-Type': 'application/json' } });
const saved = { accessToken: token, accountId: '42', expiresAt: Date.now() - 86_400_000, renewalToken: root };

test('session projection rejects unbounded, malformed and non-progressing pages and drops secrets', () => {
  const page = deviceLoginsPage({ sessions: [{ ...row, renewal_token: root }], next_cursor: null });
  assert.deepEqual(Object.keys(page.sessions[0]), ['id', 'current', 'createdAt', 'revoked']);
  assert.ok(!JSON.stringify(page).includes(root));
  for (const value of [
    { sessions: Array(51).fill(row), next_cursor: null },
    { sessions: [row, row], next_cursor: null },
    { sessions: [row], next_cursor: id },
    { sessions: [row] },
    { sessions: [{ ...row, current: 'true' }], next_cursor: null },
    { sessions: [{ ...row, created_at: 'invalid' }], next_cursor: null },
    { sessions: [{ ...row, id: root }], next_cursor: null },
  ]) assert.throws(() => deviceLoginsPage(value));
  assert.throws(() => deviceLoginsPage({ sessions: [row], next_cursor: null }, id));
});

test('expired short access does not block owner management; root stays in authorization header only', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async (url, options) => {
    ++calls;
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${root}`);
    assert.ok(!String(url).includes(root) && !String(options?.body).includes(root));
    if (String(url).endsWith('/device-sessions')) {
      assert.deepEqual(JSON.parse(String(options?.body)), {});
      return reply({ sessions: [row], next_cursor: null });
    }
    assert.ok(String(url).endsWith('/device-revoke'));
    assert.deepEqual(JSON.parse(String(options?.body)), { session_id: otherId });
    return reply({ revoked: true });
  });
  client.restore(saved);
  assert.equal((await client.listDeviceSessions()).sessions[0].id, id);
  await client.revokeDeviceSession(otherId);
  await assert.rejects(client.revokeDeviceSession(id), /Log out/);
  await assert.rejects(client.revokeDeviceSession(root), /Log out/);
  await assert.rejects(client.listDeviceSessions(root), /identifier/);
  assert.equal(calls, 2);
});

test('management response cannot be adopted after logout or account replacement', async () => {
  let resolve!: (value: Response) => void;
  const client = new HttpIdentityClient(() => new Promise<Response>(done => { resolve = done; }));
  client.restore(saved);
  const pending = client.listDeviceSessions();
  client.synchronize(null);
  resolve(reply({ sessions: [row], next_cursor: null }));
  await assert.rejects(pending, SessionChanged);
});

test('missing renewal credential never makes a management request and false revocation receipt is rejected', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async () => { ++calls; return reply({ revoked: false }); });
  await assert.rejects(client.listDeviceSessions(), /sign in once/);
  assert.equal(calls, 0);
  client.restore(saved);
  await assert.rejects(client.revokeDeviceSession(otherId), /confirm session revocation/);
  assert.equal(client.remembered, true);
});
