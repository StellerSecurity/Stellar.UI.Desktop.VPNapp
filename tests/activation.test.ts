import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient, SessionRejected } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const token = '7|' + 'A'.repeat(40);
function client(request: typeof fetch) {
  const c = new HttpIdentityClient(request);
  c.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse('2099-01-01T00:00:00Z') });
  return c;
}
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { status, headers: { 'Content-Type': 'application/json' } }); }
test('activation sends only a code in a POST body to pinned desktop API, without IDs or duration', async () => {
  let calls = 0;
  const c = client(async (url, options) => {
    calls++;
    assert.equal(url, 'https://stellar-desktop-vpn-staging-premium-dtfhc6g5hfhch2gs.westeurope-01.azurewebsites.net/api/v2/account/activation');
    assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(options?.body)), { activation_code: 'TEST-CODE' });
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return reply({ activated: true });
  });
  await c.activateCode('TEST-CODE'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(c).includes('TEST-CODE'));
});
test('activation validates before IO and deduplicates rapid submits', async () => {
  let calls = 0, finish!: (value: Response) => void;
  const c = client(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
  for (const code of ['', 'abc', 'x'.repeat(129), 'code\n', '<script>']) await assert.rejects(c.activateCode(code), /valid activation/);
  assert.equal(calls, 0);
  const pending = c.activateCode('TEST-CODE');
  await assert.rejects(c.activateCode('TEST-CODE'), /already in progress/);
  finish(reply({ activated: true })); await pending;
  assert.equal(calls, 1);
});
test('ambiguous activation responses never claim success or blindly retry; the same code can resume', async () => {
  for (const failure of [() => reply({ activated: false }), () => reply({}), () => { throw new Error('private upstream'); }, () => new Response('secret', { status: 503 })]) {
    let calls = 0;
    const c = client(async () => { calls++; return calls === 1 ? failure() : reply({ activated: true }); });
    await assert.rejects(c.activateCode('TEST-CODE'), e => e instanceof Error && !/private|secret/.test(e.message));
    assert.equal(calls, 1);
    await c.activateCode('TEST-CODE'); assert.equal(calls, 2);
  }
});
test('a late activation response after logout cannot succeed for a new session', async () => {
  let finish!: (value: Response) => void;
  const c = client(async url => String(url).endsWith('/logout') ? reply({ revoked: true }) : new Promise<Response>(resolve => { finish = resolve; }));
  const pending = c.activateCode('TEST-CODE'); await c.logout();
  finish(reply({ activated: true })); await assert.rejects(pending, SessionRejected);
});
test('activation errors are allowlisted and do not leak raw server messages', async () => {
  const c = client(async () => new Response(JSON.stringify({ error: { code: 'invalid_activation_code', message: 'SECRET-CODE' }, meta: { api_version: 'v2' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(c.activateCode('TEST-CODE'), /invalid, already used/);
  assert.equal(c.active, true);
});
test('activation invalidates an older in-flight account refresh before fetching the updated plan', async () => {
  let finish!: (value: Response) => void, accountCalls = 0;
  const account = { account_id: '42', subscription_state: 'none', subscription: null, devices_state: 'not_applicable', devices: [] };
  const c = client(async url => {
    if (String(url).endsWith('/activation')) return reply({ activated: true });
    accountCalls++;
    return accountCalls === 1 ? new Promise<Response>(resolve => { finish = resolve; }) : reply(account);
  });
  const stale = c.currentAccount(); await c.activateCode('TEST-CODE');
  finish(reply(account)); await assert.rejects(stale, /Account details changed/);
  await c.currentAccount(); assert.equal(accountCalls, 2);
});
