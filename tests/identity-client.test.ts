import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const token = '42|' + 'a'.repeat(40);
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { api_version: 'v2', mode: 'fixture' } }), { status, headers: { 'Content-Type': 'application/json' } });
const session = { access_token: token, token_type: 'Bearer', account_id: '42', expires_at: '2099-01-01T00:00:00Z' };
test('real credentials go only to the pinned staging route and bearer is never returned to UI', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async (url, options) => {
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    assert.equal(options?.method, 'POST');
    if (calls++ === 0) {
      assert.equal(url, 'https://stellar-desktop-vpn-staging-ayakcqbcfvb2fqhc.westeurope-01.azurewebsites.net/api/v2/auth/login');
      assert.deepEqual(JSON.parse(String(options?.body)), { username: 'test@example.test', password: 'synthetic-password' });
      return reply(session);
    }
    assert.ok(String(url).endsWith('/logout'));
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert.equal(options?.body, '{}');
    assert.ok(!String(url).includes(token));
    return reply({ revoked: true });
  });
  assert.equal(client.active, false);
  assert.equal(await client.authenticate('login', 'test@example.test', 'synthetic-password'), Date.parse(session.expires_at));
  assert.equal(client.active, true);
  assert.ok(!JSON.stringify(client).includes(token));
  await client.logout(); assert.equal(client.active, false); assert.equal(calls, 2);
});
test('registration has a dedicated endpoint and a failed login cannot create a session', async () => {
  const register = new HttpIdentityClient(async url => { assert.ok(String(url).endsWith('/register')); return reply(session); });
  await register.authenticate('register', 'test@example.test', 'synthetic-password'); assert.equal(register.active, true);
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'secret detail' }, meta: { api_version: 'v2' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(client.authenticate('login', 'test@example.test', 'bad'), /Email or password is incorrect/);
  assert.equal(client.active, false);
});
test('malformed, oversized, expired, redirect and network responses fail without leaking details', async () => {
  for (const response of [() => reply({ ...session, access_token: 'bad' }), () => reply({ ...session, expires_at: '2000-01-01T00:00:00Z' }),
    () => reply({ ...session, account_id: 42 }), () => reply('x'.repeat(70_000)), () => new Response('<html>private</html>'),
    () => { throw new Error('private network detail'); }]) {
    const client = new HttpIdentityClient(async () => response());
    await assert.rejects(client.authenticate('login', 'test@example.test', 'synthetic-password'), failure => failure instanceof Error && !failure.message.includes('private'));
    assert.equal(client.active, false);
  }
});
test('logout clears the token even if server revocation is unavailable', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async () => { if (calls++ === 0) return reply(session); throw new Error('offline'); });
  await client.authenticate('login', 'test@example.test', 'synthetic-password');
  await assert.rejects(client.logout()); assert.equal(client.active, false);
  await client.logout(); assert.equal(calls, 2);
});
