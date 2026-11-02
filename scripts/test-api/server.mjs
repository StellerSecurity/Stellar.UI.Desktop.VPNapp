/** Isolated contract simulator, NOT Laravel staging. No upstream requests or disk state. */
import { createServer } from 'node:http';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEMO = Object.freeze({
  username: 'desktop@example.test', password: 'StellarTest123!',
  accountNumber: '1111222233334444', resetCode: '12345678',
});
const prefix = '/api/v1';
const allowedOrigins = new Set(['http://127.0.0.1:4176', 'http://127.0.0.1:4177', 'tauri://localhost', 'http://tauri.localhost']);
const catalog = JSON.parse(readFileSync(new URL('../../assets/servers.json', import.meta.url), 'utf8'));
const hashPassword = (password, salt) => scryptSync(password, salt, 32);

export function createTestApi({ now = Date.now } = {}) {
  const users = new Map(), tokens = new Map(), resets = new Map(), attempts = new Map();
  function addUser(username, password, active = false, account = String(randomInt(1e7, 1e8)) + String(randomInt(1e7, 1e8))) {
    const salt = randomBytes(16);
    const user = { username, salt, password: hashPassword(password, salt), account, active,
      expiresAt: now() + (active ? 24 * 86400000 : 0) };
    users.set(username, user); return user;
  }
  addUser(DEMO.username, DEMO.password, true, DEMO.accountNumber);
  const success = (user, extra = {}) => {
    const token = `local-test-only-${randomBytes(24).toString('hex')}`;
    tokens.set(token, user);
    return { response_code: 200, token, device_name: 'Local Test Device',
      vpn_auth: { username: 'LOCAL_TEST_NOT_A_VPN_USER', password: 'LOCAL_TEST_NOT_A_VPN_PASSWORD' }, ...extra };
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const port = server.address()?.port;
    // Loopback binding plus Host/Origin checks prevent accidental LAN exposure and DNS rebinding.
    if (req.headers.host !== `127.0.0.1:${port}` || (origin && !allowedOrigins.has(origin))) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Stellar-Test-Environment', 'local-simulator');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    };
    const fail = (message, code = 400, http = 200) => reply({ response_code: code, response_message: message }, http);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.writeHead(204); res.end(); return;
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/up') return reply({ mode: 'local-simulator', upstream: false });
    if (req.method === 'GET' && path === `${prefix}/vpncontroller/server-list`) {
      return reply(catalog.map(location => ({ ...location, protocols: ['udp', 'tcp'],
        config_url: `http://127.0.0.1:${port}/fixtures/${location.id}.ovpn` })));
    }
    if (path.startsWith('/fixtures/')) return fail('Test fixture: no working VPN configuration exists.', 410, 410);
    if (req.method !== 'POST' || !path.startsWith(`${prefix}/`)) return fail('Not found', 404, 404);
    if (path !== `${prefix}/dashboardcontroller/home`) {
      const minute = Math.floor(now() / 60000), key = `${path}:${minute}`;
      attempts.set(key, (attempts.get(key) || 0) + 1);
      for (const item of attempts.keys()) if (!item.endsWith(`:${minute}`)) attempts.delete(item);
      if (attempts.get(key) > 20) { res.setHeader('Retry-After', '60'); return fail('Too many requests. Try again later.', 429, 429); }
    }
    let body;
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) return fail('Expected JSON', 415, 415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) return fail('Request too large', 413, 413);
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    } catch { return fail('Invalid JSON', 400, 400); }
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const email = typeof body.email === 'string' ? body.email : '';
    const user = users.get(username);
    switch (path.slice(prefix.length)) {
      case '/logincontroller/login':
        if (!user || !timingSafeEqual(hashPassword(password, user.salt), user.password)) return fail('Auth failed', 401);
        return reply(success(user, { subscription_id: user.account }));
      case '/logincontroller/register': {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || password.length < 6) return fail('Invalid registration');
        if (users.has(username)) return fail('Account already exists');
        return reply(success(addUser(username, password)));
      }
      case '/logincontroller/register/withaccountnumber': {
        const created = addUser(`anonymous-${randomBytes(8).toString('hex')}@example.test`, randomBytes(24).toString('hex'));
        return reply(success(created, { account_number: created.account.match(/.{4}/g).join(' ') }));
      }
      case '/logincontroller/login/withaccountnumber': {
        const account = typeof body.account_number === 'string' ? body.account_number.replace(/\s+/g, '') : '';
        const found = [...users.values()].find(item => item.account === account);
        if (!found) return fail('Account Number not found.');
        return reply(success(found, { account_number: found.account }));
      }
      case '/dashboardcontroller/home': {
        const found = tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
        if (!found) { res.writeHead(401); res.end(); return; } // Legacy API returns an empty 401.
        const remaining = Math.max(0, Math.ceil((found.expiresAt - now()) / 86400000));
        return reply({ user: { username: found.username }, subscription: {
          id: found.account, expires_at: new Date(found.expiresAt).toISOString(),
          status: found.active ? 1 : 0, days_remaining: remaining, expired: remaining === 0,
        } });
      }
      case '/password/forgot':
        if (!email) return fail('No email was provided');
        if (users.has(email)) resets.set(email, { code: DEMO.resetCode, expiresAt: now() + 600000 });
        return reply({ response_code: 200, response_message: 'Local test only: no email sent.' });
      case '/password/verifycode':
      case '/password/updatepassword': {
        const reset = resets.get(email);
        if (!reset || reset.code !== body.confirmation_code) return fail('Invalid code');
        if (reset.expiresAt <= now()) return fail('Code expired', 401);
        if (path.endsWith('/updatepassword')) {
          if (typeof body.new_password !== 'string' || body.new_password.length < 6) return fail('Invalid new password');
          const found = users.get(email); found.password = hashPassword(body.new_password, found.salt);
          resets.delete(email);
        }
        return reply({ response_code: 200, response_message: 'OK' });
      }
      default: return fail('Not found', 404, 404);
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STELLAR_TEST_API_PORT || 4180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local test API port');
  const server = createTestApi();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`LOCAL SIMULATOR ONLY: http://127.0.0.1:${port}/api/v1 (no upstream calls)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
