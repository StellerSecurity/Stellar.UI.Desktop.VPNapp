import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient, SessionRejected } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const old = '42|' + 'a'.repeat(40), next = '43|' + 'b'.repeat(40);
const root = 'd1' + 'a'.repeat(32) + '|' + 'c'.repeat(64);
const expired = { accessToken: old, accountId: '42', expiresAt: 1, renewalToken: root };
const response = () => ({ access_token: next, token_type: 'Bearer', account_id: '42', expires_at: new Date(Date.now() + 86400_000).toISOString() });
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { headers: { 'Content-Type': 'application/json' } });

test('saved login can renew after an arbitrary offline interval without a login password', async () => {
  let calls = 0, persisted = false;
  const client = new HttpIdentityClient(async (url, options) => {
    calls++; assert.ok(String(url).endsWith('/auth/renew'));
    assert.equal(options?.body, '{}'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + root);
    return reply(response());
  }, undefined, undefined, async (identity, expected) => {
    assert.equal(expected, old); assert.equal(identity.accountId, '42'); assert.equal(identity.renewalToken, root);
    assert.equal(client.active, false); persisted = true;
  });
  client.restore(expired); assert.equal(client.remembered, true); assert.equal(client.active, false);
  await Promise.all([client.renewSession(), client.renewSession()]);
  assert.equal(calls, 1); assert.equal(persisted, true); assert.equal(client.active, true);
  assert.ok(!JSON.stringify(client).includes(root));
});
test('network and vault failures preserve remembered login and allow renewal retry', async () => {
  let fail = true;
  const client = new HttpIdentityClient(async () => reply(response()), undefined, undefined, async () => { if (fail) throw new Error('vault locked'); });
  client.restore(expired);
  await assert.rejects(client.renewSession(), /vault locked/);
  assert.equal(client.remembered, true); assert.equal(client.active, false);
  fail = false; await client.renewSession(); assert.equal(client.active, true);
  const offline = new HttpIdentityClient(async () => { throw new Error('offline'); });
  offline.restore(expired); await assert.rejects(offline.renewSession()); assert.equal(offline.remembered, true);
});
test('only explicit renewal rejection removes the remembered login', async () => {
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error: { code: 'invalid_session' }, meta: { api_version: 'v2' } }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  }));
  client.restore(expired); await assert.rejects(client.renewSession(), SessionRejected);
  assert.equal(client.remembered, false); assert.equal(client.active, false);
});
test('malformed renewal cannot change accounts, fabricate lifetime or replace the saved token', async () => {
  for (const data of [{ ...response(), account_id: '99' }, { ...response(), access_token: 'bad' }, { ...response(), expires_at: '2099-01-01T00:00:00Z' }]) {
    const client = new HttpIdentityClient(async () => reply(data), undefined, undefined, async () => { assert.fail('must not persist'); });
    client.restore(expired); await assert.rejects(client.renewSession()); assert.equal(client.remembered, true);
  }
});
test('logout revokes the renewal credential even when the access token is already expired', async () => {
  const client = new HttpIdentityClient(async (url, options) => {
    assert.ok(String(url).endsWith('/auth/device-logout'));
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + root);
    return reply({ revoked: true });
  });
  client.restore(expired); await client.logout(); assert.equal(client.remembered, false);
});
test('a renewal completing after logout cannot restore the identity', async () => {
  let finish!: (response: Response) => void;
  const client = new HttpIdentityClient(async url => String(url).endsWith('/device-logout') ? reply({ revoked: true }) : new Promise(resolve => { finish = resolve; }), undefined, undefined, async () => { assert.fail('late persistence'); });
  client.restore(expired); const pending = client.renewSession();
  await client.logout(); finish(reply(response())); await assert.rejects(pending);
  assert.equal(client.remembered, false); assert.equal(client.active, false);
});
test('a still-valid old login upgrades in place before the renewal credential is used', async () => {
  let persisted = false;
  const expiry = Date.now() + 3600_000;
  const client = new HttpIdentityClient(async url => {
    assert.ok(String(url).endsWith('/auth/remember'));
    return reply({ ...response(), renewal_token: root });
  }, undefined, undefined, async (identity, expected) => {
    assert.equal(expected, old); assert.equal(client.remembered, false);
    assert.equal(identity.renewalToken, root); persisted = true;
  });
  client.restore({ accessToken: old, accountId: '42', expiresAt: expiry });
  await client.rememberSession(); assert.equal(persisted, true); assert.equal(client.remembered, true);
});
test('an unavailable enrollment endpoint does not discard an existing valid login', async () => {
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error: { code: 'integration_unavailable' }, meta: { api_version: 'v2' } }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  }));
  client.restore({ accessToken: old, accountId: '42', expiresAt: Date.now() + 3600_000 });
  await assert.rejects(client.rememberSession()); assert.equal(client.active, true); assert.equal(client.remembered, false);
});
test('native identity synchronization adopts another window login and clears local logout without an API call', async () => {
  const client = new HttpIdentityClient(async () => { assert.fail('no HTTP during native synchronization'); });
  client.restore(expired); const before = client.identityRevision;
  const second = { accessToken: next, accountId: '43', expiresAt: Date.now()+3600_000, renewalToken: 'd1'+'b'.repeat(32)+'|'+'d'.repeat(64) };
  client.synchronize(second); assert.ok(client.identityRevision > before); assert.equal(client.active, true);
  const stable = client.identityRevision; client.synchronize(second); assert.equal(client.identityRevision, stable);
  client.synchronize(null); assert.equal(client.remembered, false); assert.equal(client.active, false);
});
test('a delayed renewal rejection identifies the old login without exposing its secret', async () => {
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error:{code:'invalid_session'},meta:{api_version:'v2'} }),{status:401,headers:{'Content-Type':'application/json'}}));
  client.restore(expired);
  await assert.rejects(client.renewSession(), error => {
    assert.ok(error instanceof SessionRejected); assert.equal(error.sessionId, root.split('|')[0]);
    assert.ok(!JSON.stringify(error).includes(root)); return true;
  });
});
test('pending logout cleanup never revokes a different current login in client memory', async () => {
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({error:{code:'invalid_session'},meta:{api_version:'v2'}}),{status:401,headers:{'Content-Type':'application/json'}}));
  const otherRoot='d1'+'b'.repeat(32)+'|'+'d'.repeat(64);
  client.restore({...expired,accessToken:next,accountId:'43',expiresAt:Date.now()+3600_000,renewalToken:otherRoot});
  await client.revokeRememberedCredential(root);
  assert.equal(client.active,true);assert.equal(client.remembered,true);assert.equal(client.sessionId,otherRoot.split('|')[0]);
});
test('repeated logout waits for the same server confirmation before an outbox may be acknowledged', async () => {
  let finish!: (response:Response)=>void, calls=0;
  const client=new HttpIdentityClient(async()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  client.restore(expired); const id=client.sessionId!;
  const first=client.logout(id), second=client.logout(id); assert.equal(first,second);assert.equal(calls,1);
  let confirmed=false;void second.then(()=>{confirmed=true;});await Promise.resolve();assert.equal(confirmed,false);
  finish(reply({revoked:true}));await Promise.all([first,second]);assert.equal(confirmed,true);
});
test('a stale logout target cannot revoke a newly adopted login', async () => {
  const client=new HttpIdentityClient(async()=>{assert.fail('must not revoke another login');});
  client.restore(expired);const oldId=client.sessionId!;
  client.synchronize({...expired,accessToken:next,accountId:'43',renewalToken:'d1'+'b'.repeat(32)+'|'+'d'.repeat(64)});
  await assert.rejects(client.logout(oldId));assert.equal(client.remembered,true);
});
