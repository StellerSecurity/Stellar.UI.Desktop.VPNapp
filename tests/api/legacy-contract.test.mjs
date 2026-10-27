import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApi, DEMO } from '../../scripts/test-api/server.mjs';

async function fixture(t, options) {
  const server = createTestApi(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, token) => fetch(`${base}/api/v1${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { server, base, post };
}
test('legacy login keeps response envelope, token, VPN credentials and subscription ID', async t => {
  const { post } = await fixture(t);
  const response = await post('/logincontroller/login', DEMO);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.response_code, 200);
  assert.match(data.token, /^local-test-only-/);
  assert.equal(data.subscription_id, DEMO.accountNumber);
  assert.equal(typeof data.device_name, 'string');
  assert.deepEqual(Object.keys(data.vpn_auth).sort(), ['password', 'username']);
});
test('legacy failures retain HTTP 200 + response_code; unauthorized dashboard stays empty HTTP 401', async t => {
  const { post } = await fixture(t);
  const failure = await post('/logincontroller/login', { username: DEMO.username, password: 'wrong' });
  assert.equal(failure.status, 200); assert.equal((await failure.json()).response_code, 401);
  const home = await post('/dashboardcontroller/home');
  assert.equal(home.status, 401); assert.equal(await home.text(), '');
});
test('account-number spacing and subscription fields match the old client', async t => {
  const { post } = await fixture(t);
  const auth = await (await post('/logincontroller/login/withaccountnumber', { account_number: '1111 2222 3333 4444' })).json();
  assert.equal(auth.response_code, 200);
  const home = await (await post('/dashboardcontroller/home', {}, auth.token)).json();
  assert.equal(home.user.username, DEMO.username);
  assert.deepEqual(Object.keys(home.subscription).sort(), ['days_remaining', 'expired', 'expires_at', 'id', 'status']);
  assert.equal(home.subscription.days_remaining, 24); assert.equal(home.subscription.status, 1);
});
test('new accounts are inactive and expired, not silently granted a subscription', async t => {
  const { post } = await fixture(t);
  const auth = await (await post('/logincontroller/register/withaccountnumber')).json();
  assert.match(auth.account_number, /^\d{4}( \d{4}){3}$/);
  const home = await (await post('/dashboardcontroller/home', {}, auth.token)).json();
  assert.equal(home.subscription.status, 0); assert.equal(home.subscription.days_remaining, 0); assert.equal(home.subscription.expired, true);
});
test('password reset is local, one-use and uses the legacy field names', async t => {
  const { post } = await fixture(t);
  await post('/password/forgot', { email: DEMO.username });
  const payload = { email: DEMO.username, confirmation_code: DEMO.resetCode };
  assert.equal((await (await post('/password/verifycode', payload)).json()).response_code, 200);
  assert.equal((await (await post('/password/updatepassword', { ...payload, new_password: 'ChangedLocal123!' })).json()).response_code, 200);
  assert.equal((await (await post('/password/verifycode', payload)).json()).response_code, 400);
  assert.equal((await (await post('/logincontroller/login', { username: DEMO.username, password: 'ChangedLocal123!' })).json()).response_code, 200);
});
test('server catalog is a bare array with legacy metadata and nonfunctional local config URLs', async t => {
  const { base } = await fixture(t);
  const servers = await (await fetch(`${base}/api/v1/vpncontroller/server-list`)).json();
  assert.equal(servers.length, 58);
  for (const item of servers) {
    for (const field of ['id', 'name', 'country', 'lat', 'lon', 'protocols', 'config_url']) assert.ok(field in item);
    assert.ok(item.config_url.startsWith(`${base}/fixtures/`));
  }
  assert.equal((await fetch(servers[0].config_url)).status, 410);
});
test('simulator rejects cross-origin requests, oversized bodies and provides local rate limiting', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await fetch(`${base}/up`, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await post('/logincontroller/login', { padding: 'x'.repeat(17000) })).status, 413);
  for (let i = 0; i < 19; i++) await post('/logincontroller/login', {});
  const limited = await post('/logincontroller/login', {});
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
});
