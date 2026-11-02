import test from 'node:test';
import assert from 'node:assert/strict';
import { vpnAccess, subscriptionRequired, subscriptionErrorResolved } from '../src/features/account/domain/VpnAccess.ts';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
import type { VpnAccess } from '../src/features/account/domain/VpnAccess.ts';
const token = '42|' + 'a'.repeat(40);
const saved = { accessToken: token, accountId: '42', expiresAt: Date.parse('2099-01-01T00:00:00Z') };
const dto = { account_id: '42', subscription_state: 'available', subscription: { id: 'plan', status: 'active', expires_at: '2098-01-01T00:00:00Z' }, devices_state: 'available', devices: [] };
const reply = (data: unknown) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { headers: { 'Content-Type': 'application/json' } });
test('renewal clears only a subscription denial after fresh confirmed active access', () => {
  const account = { id: '42', subscriptionState: 'available' as const, subscription: { id: 'plan', status: 'active' as const, expiresAt: '2098-01-01T00:00:00Z' }, devicesState: 'available' as const, devices: [] };
  assert.equal(subscriptionErrorResolved(account, 'subscription'), true);
  assert.equal(subscriptionErrorResolved(account, null), false);
  assert.equal(subscriptionErrorResolved({ ...account, cached: true }, 'subscription'), false);
  assert.equal(subscriptionErrorResolved({ ...account, subscriptionState: 'unavailable' }, 'subscription'), false);
  assert.equal(subscriptionErrorResolved({ ...account, subscription: { ...account.subscription, status: 'inactive' } }, 'subscription'), false);
  assert.equal(subscriptionErrorResolved(account, 'subscription', Date.parse('2098-01-01T00:00:00Z')), false);
  assert.equal(subscriptionErrorResolved(null, 'subscription'), false);
});
test('fresh active and trial access are allowed; explicit inactive, expired, pending and missing plans are denied', async () => {
  for (const status of ['active', 'trial', 'inactive', 'expired', 'pending']) {
    const updates: VpnAccess[] = [];
    const client = new HttpIdentityClient(async () => reply({ ...dto, subscription: { ...dto.subscription, status } }), undefined, async access => { updates.push(access); });
    client.restore(saved);
    if (['active', 'trial'].includes(status)) await client.verifyVpnAccess();
    else await assert.rejects(client.verifyVpnAccess(), subscriptionRequired);
    assert.equal(updates[0].active, ['active', 'trial'].includes(status));
    assert.ok(client.active, 'subscription denial must not log out the account');
  }
});
test('an unavailable response can display cached data but can never grant a new connection or revoke access', async () => {
  const updates: VpnAccess[] = [];
  const client = new HttpIdentityClient(async () => reply({ ...dto, subscription_state: 'unavailable', subscription: null, devices_state: 'unavailable', devices: null }), undefined, async access => { updates.push(access); });
  client.restore(saved); client.restoreAccountCache(JSON.stringify(dto));
  await assert.rejects(client.verifyVpnAccess(), /Could not verify/);
  assert.equal(updates.length, 0);
  assert.equal(client.cachedAccount()?.subscription?.status, 'active');
});
test('subscription-specific 403 stops access without being treated as a revoked login', async () => {
  const updates: VpnAccess[] = [];
  const client = new HttpIdentityClient(async () => new Response(JSON.stringify({ error: { code: 'subscription_required' }, meta: { api_version: 'v2' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }), undefined, async access => { updates.push(access); });
  client.restore(saved);
  await assert.rejects(client.configuration('dk-1'), subscriptionRequired);
  assert.ok(client.active); assert.equal(updates[0].active, false);
});
test('a fresh expired date overrides an active status, while a missing expiry is not zero days', () => {
  const account = { id: '42', subscriptionState: 'available' as const, subscription: { id: 'plan', status: 'active' as const, expiresAt: '2026-01-01T00:00:00Z' }, devicesState: 'available' as const, devices: [] };
  assert.equal(vpnAccess(account, Date.parse('2026-01-01T00:00:00Z'))?.active, false);
  assert.equal(vpnAccess({ ...account, subscription: { ...account.subscription, expiresAt: null } })?.active, true);
  assert.equal(vpnAccess({ ...account, subscriptionState: 'none', subscription: null })?.active, false);
});
test('a delayed old-account response cannot grant native VPN access after logout', async () => {
  let release!: (value: Response) => void, updates = 0;
  const client = new HttpIdentityClient(async url => String(url).endsWith('/logout') ? reply({ revoked: true }) : new Promise<Response>(resolve => { release = resolve; }), undefined, async () => { updates++; });
  client.restore(saved); const pending = client.verifyVpnAccess(); await client.logout(); release(reply(dto));
  await assert.rejects(pending); assert.equal(updates, 0);
});
