import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const token = '42|' + 'a'.repeat(40);
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { api_version: 'v2', mode: 'fixture' } }), { status, headers: { 'Content-Type': 'application/json' } });
const session = { access_token: token, token_type: 'Bearer', account_id: '42', expires_at: '2099-01-01T00:00:00Z' };
test('anonymous account login posts only sixteen digits to the dedicated pinned route and reuses scoped session validation', async () => {
  let requests = 0;
  const client = new HttpIdentityClient(async (url, options) => {
    requests++;
    assert.ok(String(url).endsWith('/api/v2/auth/account-login'));
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(options?.body)), { account_number: '0000000000000042' });
    assert.equal((options?.headers as Record<string, string>).Authorization, undefined);
    return reply(session);
  });
  for (const invalid of ['abc', '123456789012345', '12345678901234567', '１２３４５６７８９０１２３４５６', '0000 0000 0000 0042']) {
    await assert.rejects(client.authenticate('account', invalid, ''), /16 digits/);
  }
  assert.equal(requests, 0);
  let accepted = false;
  await client.authenticate('account', '0000000000000042', '', async (_, auth, identity) => {
    assert.equal(auth, null); assert.equal(identity.accountId, '42'); assert.equal(identity.accessToken, token); accepted = true;
  });
  assert.equal(requests, 1); assert.equal(accepted, true); assert.equal(client.active, true);
  assert.ok(!JSON.stringify(client).includes('0000000000000042'));
});
test('rate limits pause shared session requests without revoking the active tunnel session', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'rate_limited' }, meta: { api_version: 'v2' } }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '120' },
    });
  });
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse(session.expires_at) });
  await assert.rejects(client.configuration('au-1'), /Location requests are temporarily limited/);
  await assert.rejects(client.currentAccount(), /Account updates are temporarily limited/);
  await assert.rejects(client.configuration('dk-1'), /Location requests are temporarily limited/);
  assert.equal(calls, 1);
  assert.equal(client.active, true);
});
test('real credentials go only to the pinned staging route and bearer is never returned to UI', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async (url, options) => {
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    assert.equal(options?.method, 'POST');
    if (calls++ === 0) {
      assert.equal(url, 'https://stellar-desktop-vpn-staging-premium-dtfhc6g5hfhch2gs.westeurope-01.azurewebsites.net/api/v2/auth/login');
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
test('one-time VPN authentication reaches only the native acceptance callback', async () => {
  const vpn = { username: 'stvpn_' + 'a'.repeat(16), password: 'b'.repeat(32) };
  const client = new HttpIdentityClient(async () => reply({ ...session, vpn_state: 'ready', vpn_auth: { ...vpn, device_id: 'synthetic' } }));
  let accepted = false;
  const expiry = await client.authenticate('login', 'test@example.test', 'synthetic-password', async (expires, auth) => {
    assert.equal(expires, Date.parse(session.expires_at)); assert.deepEqual(auth, vpn); accepted = true;
  });
  assert.equal(accepted, true); assert.equal(typeof expiry, 'number');
  assert.ok(!JSON.stringify(client).includes(vpn.password));
  for (const invalid of [{ ...vpn, password: 'account-password' }, { ...vpn, username: 'email@example.test' }]) {
    const bad = new HttpIdentityClient(async () => reply({ ...session, vpn_state: 'ready', vpn_auth: invalid }));
    await assert.rejects(bad.authenticate('login', 'test@example.test', 'synthetic-password'));
    assert.equal(bad.active, false);
  }
});
test('VPN configuration is pinned, authenticated and discarded after logout', async () => {
  let finish: (response: Response) => void = () => {};
  const client = new HttpIdentityClient(async (url, options) => {
    if (String(url).endsWith('/login')) return reply(session);
    if (String(url).endsWith('/logout')) return reply({ revoked: true });
    assert.ok(String(url).endsWith('/api/v2/vpn/configuration'));
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert.deepEqual(JSON.parse(String(options?.body)), { server_id: 'de-1' });
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  await client.authenticate('login', 'test@example.test', 'synthetic-password');
  const pending = client.configuration('de-1');
  await client.logout(); finish(reply({ server_id: 'de-1', config: 'synthetic config', sha256: 'a'.repeat(64) }));
  await assert.rejects(pending, /session has expired/);
});
test('configuration reuse is memory-only, bounded to the current login, and cleared on logout', async () => {
  let configurations = 0;
  const client = new HttpIdentityClient(async url => {
    if (String(url).endsWith('/logout')) return reply({ revoked: true });
    configurations++;
    return reply({ server_id: 'de-1', config: 'synthetic private configuration', sha256: 'a'.repeat(64) });
  });
  const saved = { accessToken: token, accountId: '42', expiresAt: Date.parse(session.expires_at) };
  client.restore(saved);
  assert.equal(await client.configuration('de-1'), await client.configuration('de-1'));
  assert.equal(configurations, 1);
  assert.ok(!JSON.stringify(client).includes('synthetic private configuration'));
  await client.logout(); await assert.rejects(client.configuration('de-1'));
  client.restore(saved); await client.configuration('de-1'); assert.equal(configurations, 2);
});
test('restoring a vault session keeps secrets outside public client state and does not require a login password', async () => {
  const client = new HttpIdentityClient(async (url, options) => {
    assert.ok(String(url).endsWith('/auth/session'));
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert.equal(options?.body, '{}');
    return reply({ account_id: '42', expires_at: session.expires_at });
  });
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse(session.expires_at) });
  assert.ok(client.active); assert.ok(!JSON.stringify(client).includes(token));
  await client.verifyRestoredSession(); assert.ok(client.active);
});
test('expired or malformed vault sessions cannot authenticate and offline verification does not erase an unexpired login', async () => {
  const client = new HttpIdentityClient(async () => { throw new Error('offline'); });
  for (const value of [null, { accessToken: 'bad', accountId: '42', expiresAt: Date.now()+1000 }, { accessToken: token, accountId: '42', expiresAt: 1 }]) {
    assert.throws(() => client.restore(value)); assert.ok(!client.active);
  }
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse(session.expires_at) });
  await assert.rejects(client.verifyRestoredSession()); assert.ok(client.active);
});
test('revoked restored sessions are rejected by the API instead of being extended locally', async () => {
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error: { code: 'invalid_session' }, meta: { api_version: 'v2' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse(session.expires_at) });
  await assert.rejects(client.verifyRestoredSession()); assert.ok(!client.active);
});
