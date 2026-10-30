import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCacheData, decodeAccount, describeSubscription, mergeAccount, subscriptionExpiring, type Account } from '../src/features/account/domain/Account.ts';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
const token = '42|' + 'a'.repeat(40);
const dto = { account_id: '42', subscription_state: 'available', subscription: { id: 'real-subscription', status: 'active', expires_at: '2099-01-01T00:00:00Z' }, devices_state: 'available', devices: [{ id: '1', name: 'Real device name' }] };
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { headers: { 'Content-Type': 'application/json' } });
test('subscription warning starts at fourteen days, includes expiry and never invents missing expiry', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const account = decodeAccount(dto, '42');
  for (const days of [15, 14, 7, 1, 0, -1]) {
    const sub = { ...account, subscription: { ...account.subscription!, expiresAt: new Date(now + days * 86400000).toISOString() } };
    assert.equal(subscriptionExpiring(sub, now), days <= 14, String(days));
  }
  assert.equal(subscriptionExpiring(null, now), false);
  assert.equal(subscriptionExpiring({ ...account, subscription: null }, now), false);
  assert.equal(subscriptionExpiring({ ...account, subscription: { ...account.subscription!, expiresAt: null } }, now), false);
});
test('private cached account data is validated, account-bound and cleared on logout', async () => {
  const client = new HttpIdentityClient(async () => reply({ revoked: true }));
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(client.restoreAccountCache(JSON.stringify({ ...dto, account_id: '99' })), null);
  assert.equal(client.restoreAccountCache('{bad'), null);
  assert.equal(client.restoreAccountCache(JSON.stringify(dto))?.id, '42');
  assert.ok(client.cachedAccount()?.cached);
  const copy = client.cachedAccount()!; copy.devices![0].name = 'changed';
  assert.equal(client.cachedAccount()?.devices?.[0].name, 'Real device name');
  assert.ok(!JSON.stringify(client).includes('Real device name'));
  await client.logout(); assert.equal(client.cachedAccount(), null);
});
test('partial upstream outages preserve known account sections but never another subscription device list', () => {
  const previous = decodeAccount(dto, '42');
  const unavailable = decodeAccount({ ...dto, subscription_state: 'unavailable', subscription: null, devices_state: 'unavailable', devices: null }, '42');
  const merged = mergeAccount(previous, unavailable);
  assert.equal(merged.subscription?.id, previous.subscription?.id);
  assert.deepEqual(merged.devices, previous.devices); assert.ok(merged.cached);
  assert.equal(decodeAccount(JSON.parse(accountCacheData(merged)), '42').devices?.length, 1);
  const changed = decodeAccount({ ...dto, subscription: { ...dto.subscription, id: 'other-plan' }, devices_state: 'unavailable', devices: null }, '42');
  assert.equal(mergeAccount(previous, changed).devices, null);
  const none = decodeAccount({ ...dto, subscription_state: 'none', subscription: null, devices_state: 'not_applicable', devices: [] }, '42');
  assert.equal(mergeAccount(previous, none).subscription, null);
  assert.equal(decodeAccount(JSON.parse(accountCacheData(mergeAccount(none, unavailable))), '42').subscriptionState, 'none');
});
test('simultaneous account reads share one request and a cache writer receives only validated display data', async () => {
  let calls = 0, saved = '';
  const client = new HttpIdentityClient(async () => { calls++; return reply({ ...dto, password: 'do-not-cache', access_token: token }); }, async (data, owner) => { assert.equal(owner, token); saved = data; });
  client.restore({ accessToken: token, accountId: '42', expiresAt: Date.parse('2099-01-01T00:00:00Z') });
  const [a, b] = await Promise.all([client.currentAccount(), client.currentAccount()]);
  assert.equal(calls, 1); assert.equal(a.id, b.id);
  assert.ok(!saved.includes(token)); assert.ok(!saved.includes('do-not-cache'));
  a.devices![0].name = 'changed'; assert.notEqual(b.devices![0].name, 'changed');
});
test('account data is bound to the authenticated account and never uses fixture identifiers', () => {
  assert.equal(decodeAccount(dto, '42').subscription?.id, 'real-subscription');
  for (const invalid of [{ ...dto, account_id: '99' }, { ...dto, subscription: { ...dto.subscription, status: 'invented' } },
    { ...dto, subscription_state: 'none' }, { ...dto, subscription: { ...dto.subscription, expires_at: 'tomorrow' } }]) {
    assert.throws(() => decodeAccount(invalid, '42'));
  }
});
test('unavailable subscriptions are not presented as expired, missing or zero days', () => {
  const account = decodeAccount({ account_id: '42', subscription_state: 'unavailable', subscription: null, devices_state: 'unavailable', devices: null }, '42');
  assert.equal(describeSubscription(account).remaining, null);
  assert.equal(describeSubscription(account).title, 'Subscription unavailable');
  assert.equal(describeSubscription({ ...account, subscriptionState: 'none' }).title, 'No VPN subscription found');
});
test('device data is validated and never invents online status or a six-device limit', () => {
  const account = decodeAccount(dto, '42');
  assert.deepEqual(account.devices, [{ id: '1', name: 'Real device name' }]);
  assert.equal('deviceLimit' in account, false);
  assert.equal(decodeAccount({ ...dto, devices: [{ id: '3ff114ac-7a0c-4f9e-b064-f9fe67e38ae3', name: 'Real UUID device' }] }, '42').devices?.length, 1);
  for (const devices of [[{ id: '1', name: '' }], [{ id: '1', name: 'bad\nname' }], [dto.devices[0], dto.devices[0]]]) {
    assert.throws(() => decodeAccount({ ...dto, devices }, '42'));
  }
  assert.equal(decodeAccount({ ...dto, devices_state: 'unavailable', devices: null }, '42').devices, null);
});
test('plan display distinguishes trial, inactive, expired and deferred activation without fake periods', () => {
  const account = decodeAccount(dto, '42');
  const withSub = (status: NonNullable<Account['subscription']>['status'], expiresAt: string | null) => ({ ...account, subscription: { id: 'real-subscription', status, expiresAt } });
  assert.equal(describeSubscription(withSub('active', null)).remaining, null);
  assert.equal(describeSubscription(withSub('inactive', '2099-01-01T00:00:00Z')).title, 'Subscription inactive');
  assert.equal(describeSubscription(withSub('active', '2000-01-01T00:00:00Z')).title, 'Subscription expired');
  assert.equal(describeSubscription(withSub('active', '2000-01-01T00:00:00Z')).expired, true);
  assert.equal(describeSubscription(withSub('expired', null)).expired, true);
  assert.equal(describeSubscription(withSub('inactive', '2099-01-01T00:00:00Z')).expired, false);
  assert.equal(describeSubscription(withSub('active', null)).expired, false);
  const boundary = Date.parse('2026-10-30T00:00:00Z');
  assert.equal(describeSubscription(withSub('active', '2026-10-30T00:00:00Z'), boundary - 1).expired, false);
  assert.equal(describeSubscription(withSub('active', '2026-10-30T00:00:00Z'), boundary).expired, true);
  assert.equal(describeSubscription(withSub('trial', null)).title, 'Trial subscription');
  assert.equal(describeSubscription(withSub('pending', null)).title, 'Awaiting activation');
});
test('account requests send only a bearer to the pinned route, never a user-selected ID', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async (url, options) => {
    if (++calls === 1) return reply({ access_token: token, token_type: 'Bearer', account_id: '42', expires_at: '2099-01-01T00:00:00Z' });
    assert.equal(url, 'https://stellar-desktop-vpn-staging-premium-dtfhc6g5hfhch2gs.westeurope-01.azurewebsites.net/api/v2/account');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    assert.equal(options?.body, '{}');
    return reply(dto);
  });
  await assert.rejects(client.currentAccount(), /session has expired/);
  assert.equal(calls, 0);
  await client.authenticate('login', 'synthetic@example.test', 'synthetic-password');
  assert.equal((await client.currentAccount()).id, '42');
  assert.ok(!JSON.stringify(client).includes(token));
});
test('an in-flight account response cannot restore private data after logout', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new HttpIdentityClient(async url => {
    if (String(url).endsWith('/login')) return reply({ access_token: token, token_type: 'Bearer', account_id: '42', expires_at: '2099-01-01T00:00:00Z' });
    if (String(url).endsWith('/logout')) return reply({ revoked: true });
    await gate; return reply(dto);
  });
  await client.authenticate('login', 'synthetic@example.test', 'synthetic-password');
  const pending = client.currentAccount();
  await client.logout(); release();
  await assert.rejects(pending, /session has expired/);
});
