import { STAGING_API_BASE } from '../config/Staging.ts';
import { accountCacheData, decodeAccount, mergeAccount, type Account } from '../../features/account/domain/Account.ts';
import { apiRequest } from '../http/ApiRetry.ts';
import { vpnAccess, SubscriptionRequired, type VpnAccess } from '../../features/account/domain/VpnAccess.ts';
const BASE = `${STAGING_API_BASE}/auth/`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type VpnLoginAuth = { username: string; password: string };
export type RememberedIdentity = { accessToken: string; accountId: string; expiresAt: number };
export class SessionRejected extends Error {}
const messages: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  invalid_session: 'Your session has expired. Please log in again.',
  registration_unavailable: 'Could not create this account. Try logging in instead.',
  invalid_input: 'Please check your email and password.',
  validation_failed: 'Please check your email and password. New passwords need at least 6 characters.',
  rate_limited: 'Too many attempts. Please try again later.',
  integration_unavailable: 'Stellar account sign-in is temporarily unavailable. Please try again shortly.',
};

/** Secrets remain private adapter state; only the native OS vault may persist a session. */
export class HttpIdentityClient {
  #rateLimits = new Map<string, number>();
  #token: string | null = null;
  #expiresAt = 0;
  #accountId: string | null = null;
  #accountCache: Account | null = null;
  #accountRequest: { token: string; promise: Promise<Account> } | null = null;
  #accountRevision = 0;
  #activationRequest = false;
  #configurations = new Map<string, { config: string; expiresAt: number }>();
  #verifiedAccess: VpnAccess | null = null;
  #vpnAuthRequest: { token: string; promise: Promise<void> } | null = null;
  private readonly request: typeof fetch;
  private readonly rememberAccount?: (data: string, token: string) => Promise<void>;
  private readonly acceptAccess?: (access: VpnAccess, token: string) => Promise<void>;
  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis), rememberAccount?: (data: string, token: string) => Promise<void>, acceptAccess?: (access: VpnAccess, token: string) => Promise<void>) { this.request = request; this.rememberAccount = rememberAccount; this.acceptAccess = acceptAccess; }

  async authenticate(operation: 'login' | 'register' | 'account', email: string, password: string, accept?: (expiresAt: number, vpnAuth: VpnLoginAuth | null, identity: RememberedIdentity) => Promise<void>): Promise<number> {
    if (operation === 'account' && !/^[0-9]{16}$/.test(email)) throw new Error('Enter all 16 digits.');
    const data = operation === 'account' ? await this.send('account-login', { account_number: email }) : await this.send(operation, { username: email, password });
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (typeof data.access_token !== 'string' || !/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/.test(data.access_token)
      || data.access_token.length > 256 || data.token_type !== 'Bearer'
      || typeof data.account_id !== 'string' || !/^[1-9][0-9]*$/.test(data.account_id)
      || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Stellar returned an invalid session. Please try again.');
    let vpnAuth: VpnLoginAuth | null = null;
    if (data.vpn_state === 'ready') {
      if (!object(data.vpn_auth) || typeof data.vpn_auth.username !== 'string' || !/^stvpn_[a-f0-9]{16}$/.test(data.vpn_auth.username)
        || typeof data.vpn_auth.password !== 'string' || !/^[a-f0-9]{32}$/.test(data.vpn_auth.password)) throw new Error('Stellar returned invalid VPN authentication. Please log in again.');
      vpnAuth = { username: data.vpn_auth.username, password: data.vpn_auth.password };
    } else if (data.vpn_auth != null) throw new Error('Stellar returned invalid VPN authentication.');
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    this.#token = data.access_token;
    this.#expiresAt = expiry;
    this.#accountId = data.account_id;
    // Native adapter consumes the one-time VPN secret; it is not returned to React state.
    if (accept) await accept(expiry, vpnAuth, { accessToken: data.access_token, accountId: data.account_id, expiresAt: expiry });
    return expiry;
  }

  get active(): boolean { return this.#token !== null && this.#expiresAt > Date.now(); }

  restore(value: unknown): void {
    if (!object(value) || typeof value.accessToken !== 'string' || !/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/.test(value.accessToken)
      || value.accessToken.length > 256 || typeof value.accountId !== 'string' || !/^[1-9][0-9]*$/.test(value.accountId)
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
      throw new SessionRejected(messages.invalid_session);
    }
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    this.#token = value.accessToken; this.#accountId = value.accountId; this.#expiresAt = value.expiresAt;
  }
  cachedAccount(): Account | null { return this.active && this.#accountCache ? structuredClone(this.#accountCache) : null; }
  restoreAccountCache(data: unknown): Account | null {
    if (!this.active || !this.#accountId || typeof data !== 'string' || data.length > 49_152) return null;
    try { this.#accountCache = { ...decodeAccount(JSON.parse(data), this.#accountId), cached: true }; return this.cachedAccount(); }
    catch { return null; }
  }

  async verifyRestoredSession(): Promise<void> {
    const token = this.#token;
    if (!this.active || !token) throw new SessionRejected(messages.invalid_session);
    const data = await this.send('session', {}, token);
    if (token !== this.#token) return;
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (data.account_id !== this.#accountId || !Number.isFinite(expiry) || expiry <= Date.now()) {
      this.#token = null; this.#expiresAt = 0; this.#accountId = null;
      this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
      throw new SessionRejected(messages.invalid_session);
    }
    // Restoration must never extend the original token lifetime.
    this.#expiresAt = Math.min(this.#expiresAt, expiry);
  }

  currentAccount(): Promise<Account> {
    const token = this.#token;
    if (token && this.active && this.#accountRequest?.token === token) return this.#accountRequest.promise.then(account => structuredClone(account));
    const promise = this.fetchAccount();
    if (token) {
      this.#accountRequest = { token, promise };
      void promise.finally(() => { if (this.#accountRequest?.promise === promise) this.#accountRequest = null; }).catch(() => {});
    }
    return promise.then(account => structuredClone(account));
  }
  private async fetchAccount(): Promise<Account> {
    const token = this.#token, accountId = this.#accountId;
    const revision = this.#accountRevision;
    if (!this.active || !token || !accountId) throw new Error(messages.invalid_session);
    const data = await this.send('account', {}, token);
    // Reject a response arriving after logout or after a different login.
    if (this.#token !== token || !this.active) throw new Error(messages.invalid_session);
    if (revision !== this.#accountRevision) throw new Error('Account details changed. Refresh to see your updated subscription.');
    const fresh = decodeAccount(data, accountId);
    this.#verifiedAccess = vpnAccess(fresh);
    if (this.#verifiedAccess) {
      if (!this.#verifiedAccess.active) this.#configurations.clear();
      await this.acceptAccess?.(this.#verifiedAccess, token);
      if (this.#token !== token || !this.active || revision !== this.#accountRevision) throw new Error(messages.invalid_session);
    }
    const account = mergeAccount(this.#accountCache, fresh);
    this.#accountCache = account;
    // Persistence is an optional protected-vault operation, never a reason to
    // discard a successful live response or downgrade to plaintext storage.
    void this.rememberAccount?.(accountCacheData(account), token).catch(() => {});
    return account;
  }
  async verifyVpnAccess(): Promise<void> {
    await this.currentAccount();
    if (!this.#verifiedAccess) throw new Error('Could not verify your subscription. Please try again.');
    if (!this.#verifiedAccess.active) throw new SubscriptionRequired();
  }
  async ensureVpnAuth(needed: (token: string) => Promise<boolean>, accept: (auth: VpnLoginAuth, token: string) => Promise<void>): Promise<void> {
    const token = this.#token, revision = this.#accountRevision;
    if (!this.active || !token) throw new SessionRejected(messages.invalid_session);
    if (this.#vpnAuthRequest?.token === token) return this.#vpnAuthRequest.promise;
    const current = () => {
      if (token !== this.#token || !this.active || revision !== this.#accountRevision) throw new Error(messages.invalid_session);
    };
    const promise = (async () => {
      if (!await needed(token)) { current(); return; }
      current();
      // Device registration is a mutation: never blindly retry this request.
      const data = await this.send('vpn-auth', {}, token);
      current();
      if (data.vpn_state !== 'ready' || !object(data.vpn_auth)
        || typeof data.vpn_auth.username !== 'string' || !/^stvpn_[a-f0-9]{16}$/.test(data.vpn_auth.username)
        || typeof data.vpn_auth.password !== 'string' || !/^[a-f0-9]{32}$/.test(data.vpn_auth.password)) throw new Error('Stellar returned invalid VPN authentication.');
      await accept({ username: data.vpn_auth.username, password: data.vpn_auth.password }, token);
      current();
    })();
    this.#vpnAuthRequest = { token, promise };
    try { await promise; }
    finally { if (this.#vpnAuthRequest?.promise === promise) this.#vpnAuthRequest = null; }
  }
  async configuration(serverId: string): Promise<string> {
    const token = this.#token;
    if (!this.active || !token) throw new Error(messages.invalid_session);
    if (!/^[a-z0-9-]{1,64}$/.test(serverId)) throw new Error('Choose an available location.');
    const cached = this.#configurations.get(serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.config;
    const data = await this.send('configuration', { server_id: serverId }, token);
    if (this.#token !== token || !this.active) throw new Error(messages.invalid_session);
    if (data.server_id !== serverId || typeof data.config !== 'string' || data.config.length > 131072
      || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Invalid VPN configuration.');
    if (this.#configurations.size >= 64) this.#configurations.clear();
    this.#configurations.set(serverId, { config: data.config, expiresAt: Math.min(this.#expiresAt, Date.now() + 300_000) });
    return data.config;
  }

  async activateCode(code: string): Promise<void> {
    const token = this.#token;
    if (!this.active || !token) throw new SessionRejected(messages.invalid_session);
    if (!/^[A-Za-z0-9-]{4,128}$/.test(code)) throw new Error('Enter a valid activation code.');
    if (this.#activationRequest) throw new Error('Activation is already in progress.');
    this.#activationRequest = true;
    try {
      const data = await this.send('activation', { activation_code: code }, token);
      if (this.#token !== token || !this.active) throw new SessionRejected(messages.invalid_session);
      if (data.activated !== true) throw new Error('Activation could not be confirmed. Retry the same code to resume safely.');
      this.#accountRevision++; this.#accountRequest = null;
    } finally { this.#activationRequest = false; }
  }

  async logout(): Promise<void> {
    const token = this.#token;
    // Always clear local access, including when offline revocation fails.
    this.#token = null; this.#expiresAt = 0; this.#accountId = null;
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    if (token) await this.send('logout', {}, token);
  }

  private async send(operation: 'login' | 'register' | 'account-login' | 'logout' | 'account' | 'configuration' | 'session' | 'activation' | 'vpn-auth', body: Record<string, string>, token?: string): Promise<Record<string, unknown>> {
    const bucket = ['login', 'register', 'account-login'].includes(operation) ? 'credentials' : 'session';
    const limitMessage = operation === 'configuration' ? 'Location requests are temporarily limited. Wait a moment before switching again.'
      : bucket === 'credentials' ? 'Sign-in requests are temporarily limited. Please wait before trying again.'
      : 'Account updates are temporarily limited. Please wait before refreshing.';
    if ((this.#rateLimits.get(bucket) ?? 0) > Date.now()) throw new Error(limitMessage);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let data: unknown, status = 0;
    try {
      const response = await apiRequest(this.request, operation === 'vpn-auth' ? `${STAGING_API_BASE}/vpn/auth` : operation === 'activation' ? `${STAGING_API_BASE}/account/activation` : operation === 'account' ? `${STAGING_API_BASE}/account` : operation === 'configuration' ? `${STAGING_API_BASE}/vpn/configuration` : BASE + operation, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }, ['account', 'configuration', 'session'].includes(operation), undefined, () => operation === 'logout' || !token || this.#token === token);
      status = response.status;
      if (status === 429) {
        const header = response.headers.get('Retry-After');
        const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 60_000;
        this.#rateLimits.set(bucket, Date.now() + Math.min(86_400_000, Math.max(1000, Number.isFinite(wait) ? wait : 60_000)));
      }
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (operation === 'configuration' ? 262_144 : 65_536)) throw new Error();
          text += decoder.decode(chunk.value, { stream: true });
        }
        data = JSON.parse(text + decoder.decode());
      } finally { await reader.cancel(); reader.releaseLock(); }
    } catch {
      throw new Error('Could not reach Stellar. Check your connection and try again.');
    } finally { clearTimeout(timer); }
    if (!object(data) || !object(data.meta) || data.meta.api_version !== 'v2') throw new Error('Stellar returned an invalid response.');
    if (status !== 200) {
      if (status === 429) throw new Error(limitMessage);
      const code = object(data.error) && typeof data.error.code === 'string' ? data.error.code : '';
      if (operation === 'account-login' && code === 'invalid_credentials') throw new Error('This anonymous account number was not found. Check the number and try again.');
      if (operation === 'account-login' && ['invalid_input', 'validation_failed'].includes(code)) throw new Error('Enter all 16 digits.');
      if (token && this.#token === token && status === 403 && code === 'subscription_required' && (operation === 'configuration' || operation === 'vpn-auth')) {
        this.#verifiedAccess = { active: false, expiresAt: null }; this.#configurations.clear();
        await this.acceptAccess?.(this.#verifiedAccess, token);
        throw new SubscriptionRequired();
      }
      if (operation === 'activation' && ![401, 403].includes(status)) {
        const activationMessages: Record<string, string> = {
          invalid_activation_code: 'This code is invalid, already used, or belongs to another subscription.',
          subscription_required: 'No VPN subscription was found for this account.',
          activation_unavailable: 'Activation is temporarily unavailable. If you already submitted this code, retry the same code to resume safely.',
        };
        throw new Error(activationMessages[code] || 'Activation could not be confirmed. Retry the same code to resume safely.');
      }
      if (token && [401, 403].includes(status)) {
        // A late rejection from an older login must not revoke a newer one.
        if (this.#token !== token) throw new Error(messages.invalid_session);
        if (this.#token === token) { this.#token = null; this.#expiresAt = 0; this.#accountId = null; this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear(); }
        throw new SessionRejected(messages.invalid_session);
      }
      if (code === 'integration_unavailable' && operation === 'account') throw new Error('Couldn’t update your account.');
      if (code === 'integration_unavailable' && operation === 'configuration') throw new Error('Couldn’t load this VPN location. Please try again.');
      throw new Error(messages[code] || 'The request could not be completed. Please try again.');
    }
    if (!object(data.data)) throw new Error('Stellar returned an invalid response.');
    if (operation === 'logout' && data.data.revoked !== true) throw new Error('Could not confirm session revocation. Your local session has been cleared.');
    return data.data;
  }
}
