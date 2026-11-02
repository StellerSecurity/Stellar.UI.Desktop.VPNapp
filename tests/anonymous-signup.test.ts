import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIdentityClient } from '../src/infrastructure/auth/HttpIdentityClient.ts';
import { SessionService } from '../src/features/auth/application/SessionService.ts';
import { readFileSync } from 'node:fs';
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { api_version: 'v2' } }), { status, headers: { 'Content-Type': 'application/json' } });

test('anonymous creation is an unauthenticated, pinned POST with no caller identity and no session side effects', async () => {
  let calls = 0;
  let deliver!: (value: Response) => void;
  const client = new HttpIdentityClient(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://stellaruidesktopvpnapiprod.azurewebsites.net/api/v2/auth/account-create');
    assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return new Promise(resolve => { deliver = resolve; });
  });
  const first = client.createAnonymousAccount(), second = client.createAnonymousAccount();
  assert.equal(first, second); assert.equal(calls, 1);
  deliver(reply({ account_number: '0000000000000042', token: 'must-not-be-imported' }));
  assert.equal(await first, '0000000000000042'); assert.equal(client.active, false);
  assert.ok(!JSON.stringify(client).includes('0000000000000042'));
});
test('creation rejects malformed numbers and ambiguous failures without an automatic replay or leaked response', async () => {
  for (const response of [() => reply({ account_number: 1234567812345678 }), () => reply({ account_number: '0000 0000 0000 0042' }),
    () => reply({ account_number: '123' }), () => reply({ account_number: '１２３４５６７８９０１２３４５６' }),
    () => new Response('<private server details>', { status: 503 }), () => { throw new Error('private transport details'); }]) {
    let calls = 0;
    const client = new HttpIdentityClient(async () => { calls++; return response(); });
    await assert.rejects(client.createAnonymousAccount(), error => error instanceof Error && !error.message.includes('private'));
    assert.equal(calls, 1); assert.equal(client.active, false);
  }
});
test('creation throttling does not prevent an existing account from signing in', async () => {
  let calls = 0;
  const client = new HttpIdentityClient(async url => {
    calls++;
    if (String(url).endsWith('/account-create')) return new Response(JSON.stringify({ error: { code: 'rate_limited' }, meta: { api_version: 'v2' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } });
    return reply({ access_token: '42|' + 'a'.repeat(40), token_type: 'Bearer', account_id: '42', expires_at: '2099-01-01T00:00:00Z' });
  });
  await assert.rejects(client.createAnonymousAccount());
  await assert.rejects(client.createAnonymousAccount());
  assert.equal(calls, 1);
  await client.authenticate('account', '0000000000000042', '');
  assert.equal(calls, 2); assert.equal(client.active, true);
});
test('the session use case delegates creation without logging in, and both signup links stay inside the app', async () => {
  const service = new SessionService({ createAnonymousAccount: async () => '0000000000000042' } as ConstructorParameters<typeof SessionService>[0]);
  assert.equal(await service.createAnonymousAccount(), '0000000000000042');
  const source = readFileSync(new URL('../src/features/auth/ui/AuthFlow.tsx', import.meta.url), 'utf8');
  assert.ok(!source.includes('https://stellarvpn.org/register'));
  assert.equal((source.match(/onAnonymous=\{\(\) => navigate\('anonymous'\)\}/g) || []).length, 2);
  const signup = readFileSync(new URL('../src/features/auth/ui/AnonymousSignup.tsx', import.meta.url), 'utf8');
  assert.ok(signup.includes('!!number && !saved'));
  assert.ok(!/localStorage|sessionStorage|console\./.test(signup));
});
