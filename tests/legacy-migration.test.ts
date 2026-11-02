import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient, SessionRejected } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const old = '7|' + 'a'.repeat(40), replacement = '8|' + 'b'.repeat(40);
const expiry = new Date(Date.now() + 3600_000).toISOString();
const session = { access_token: replacement, token_type: 'Bearer', account_id: '42', expires_at: expiry };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { status, headers: { 'Content-Type': 'application/json' } });
test('legacy migration sends only the old bearer to a fixed POST and verifies replacement before persistence', async () => {
  const calls: string[] = [];
  const client = new HttpIdentityClient(async (url, options) => {
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
    assert.equal(options?.cache, 'no-store'); assert.equal(options?.method, 'POST');
    assert.equal(options?.body, '{}'); assert.ok(!String(url).includes(old));
    const auth = (options?.headers as Record<string, string>).Authorization;
    calls.push(String(url));
    if (calls.length === 1) {
      assert.equal(url, 'https://stellaruidesktopvpnapiprod.azurewebsites.net/api/v2/auth/migrate-legacy');
      assert.equal(auth, 'Bearer ' + old); return reply(session);
    }
    assert.ok(String(url).endsWith('/auth/session')); assert.equal(auth, 'Bearer ' + replacement);
    return reply({ account_id: '42', expires_at: expiry });
  });
  let persisted = false;
  await client.migrateLegacy(old, async identity => {
    assert.equal(calls.length, 2); assert.equal(identity.accessToken, replacement); assert.equal(identity.accountId, '42'); persisted = true;
  });
  assert.equal(persisted, true); assert.equal(client.active, true);
  assert.ok(!JSON.stringify(client).includes(old)); assert.ok(!JSON.stringify(client).includes(replacement));
});
test('offline exchange and locked vault preserve retry and never revoke either session', async () => {
  let requests = 0;
  const client = new HttpIdentityClient(async url => {
    requests++; assert.ok(!String(url).endsWith('/logout'));
    return reply(String(url).endsWith('/migrate-legacy') ? session : { account_id: '42', expires_at: expiry });
  });
  await assert.rejects(client.migrateLegacy(old, async () => { throw new Error('Vault locked'); }));
  assert.equal(client.active, false);
  await client.migrateLegacy(old, async () => {}); assert.equal(client.active, true); assert.equal(requests, 4);
  const offline = new HttpIdentityClient(async () => { throw new TypeError('offline'); });
  await assert.rejects(offline.migrateLegacy(old, async () => { assert.fail('must not persist'); }));
  assert.equal(offline.active, false);
});
test('bad, expired, unchanged or excessive lifetime responses cannot migrate', async () => {
  for (const data of [{ ...session, access_token: old }, { ...session, expires_at: '2000-01-01T00:00:00Z' },
    { ...session, access_token: 'invalid' }, { ...session, account_id: 42 }, { ...session, expires_at: '2099-01-01T00:00:00Z' }]) {
    const client = new HttpIdentityClient(async () => reply(data));
    await assert.rejects(client.migrateLegacy(old, async () => { assert.fail('must not persist'); }));
    assert.equal(client.active, false);
  }
});
test('a logout during exchange prevents a late migration from restoring login', async () => {
  let resolve!: (response: Response) => void;
  const client = new HttpIdentityClient(() => new Promise(r => { resolve = r; }));
  const pending = client.migrateLegacy(old, async () => { assert.fail('late persistence'); });
  await client.logout(); resolve(reply(session));
  await assert.rejects(pending, SessionRejected); assert.equal(client.active, false);
});
