import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
import { subscriptionRequired } from '../src/features/account/domain/VpnAccess.ts';
const token = '42|' + 'a'.repeat(40);
const saved = { accessToken: token, accountId: '42', expiresAt: Date.parse('2099-01-01T00:00:00Z') };
const auth = { username: 'stvpn_' + 'a'.repeat(16), password: 'b'.repeat(32) };
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { headers: { 'Content-Type': 'application/json' } });
test('post-activation credentials use existing bearer, no account password or caller-owned IDs', async () => {
  let calls = 0, accepted = false;
  const client = new HttpIdentityClient(async (url, options) => {
    calls++;
    assert.ok(String(url).endsWith('/api/v2/vpn/auth'));
    assert.equal(options?.method, 'POST'); assert.equal(options?.body, '{}');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert.equal(options?.cache, 'no-store'); assert.equal(options?.credentials, 'omit');
    return reply({ vpn_state: 'ready', vpn_auth: auth });
  });
  client.restore(saved);
  await client.ensureVpnAuth(async expected => { assert.equal(expected, token); return true; }, async (value, expected) => {
    assert.deepEqual(value, auth); assert.equal(expected, token); accepted = true;
  });
  assert.equal(calls, 1); assert.ok(accepted); assert.ok(client.active);
  assert.ok(!JSON.stringify(client).includes(auth.password));
});
test('working native credentials are never rotated; simultaneous setup is coalesced', async () => {
  let calls = 0, accepted = 0;
  const client = new HttpIdentityClient(async () => { calls++; return reply({ vpn_state: 'ready', vpn_auth: auth }); });
  client.restore(saved);
  await client.ensureVpnAuth(async () => false, async () => { accepted++; });
  assert.equal(calls, 0);
  await Promise.all([1, 2, 3].map(() => client.ensureVpnAuth(async () => true, async () => { accepted++; })));
  assert.equal(calls, 1); assert.equal(accepted, 1);
});
test('confirmed activation survives a setup outage; later connect setup retries without login or redeeming again', async () => {
  let activations = 0, setups = 0, accepted = 0;
  const client = new HttpIdentityClient(async url => {
    if (String(url).endsWith('/account/activation')) { activations++; return reply({ activated: true }); }
    assert.ok(String(url).endsWith('/vpn/auth'));
    if (++setups === 1) throw new Error('offline');
    return reply({ vpn_state: 'ready', vpn_auth: auth });
  });
  client.restore(saved);
  await client.activateCode('TEST-CODE');
  await assert.rejects(client.ensureVpnAuth(async () => true, async () => { accepted++; }));
  await client.ensureVpnAuth(async () => true, async () => { accepted++; });
  assert.equal(activations, 1); assert.equal(setups, 2); assert.equal(accepted, 1); assert.ok(client.active);
});
test('late setup after logout is rejected before native acceptance', async () => {
  let release!: (response: Response) => void, accepted = 0;
  const client = new HttpIdentityClient(async url => String(url).endsWith('/logout') ? reply({ revoked: true }) : new Promise<Response>(resolve => { release = resolve; }));
  client.restore(saved);
  const pending = client.ensureVpnAuth(async () => true, async () => { accepted++; });
  await new Promise(resolve => setImmediate(resolve));
  await client.logout(); release(reply({ vpn_state: 'ready', vpn_auth: auth }));
  await assert.rejects(pending); assert.equal(accepted, 0);
});
test('inactive subscription keeps login, malformed secrets cannot reach native, mutation failures are not retried', async () => {
  for (const scenario of ['inactive', 'malformed', 'outage']) {
    let calls = 0, accepted = 0;
    const client = new HttpIdentityClient(async () => {
      calls++;
      if (scenario === 'malformed') return reply({ vpn_state: 'ready', vpn_auth: { ...auth, password: 'bad' } });
      return new Response(JSON.stringify({ error: { code: scenario === 'inactive' ? 'subscription_required' : 'integration_unavailable' }, meta: { api_version: 'v2' } }), { status: scenario === 'inactive' ? 403 : 503, headers: { 'Content-Type': 'application/json' } });
    });
    client.restore(saved);
    const pending = client.ensureVpnAuth(async () => true, async () => { accepted++; });
    if (scenario === 'inactive') await assert.rejects(pending, subscriptionRequired); else await assert.rejects(pending);
    assert.equal(accepted, 0); assert.equal(calls, 1); assert.ok(client.active);
  }
});
