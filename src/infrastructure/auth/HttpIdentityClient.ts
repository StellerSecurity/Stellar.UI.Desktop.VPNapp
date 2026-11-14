import { deviceLoginsPage, validDeviceSessionId } from '../../features/devices/domain/DeviceSession.ts';
import { PRODUCTION_API_BASE } from '../config/Production.ts';
import { ANONYMOUS_SIGNUP_URL } from '../config/Signup.ts';
import { accountCacheData, decodeAccount, mergeAccount, type Account } from '../../features/account/domain/Account.ts';
import { apiRequest } from '../http/ApiRetry.ts';
import { vpnAccess, SubscriptionRequired, type VpnAccess } from '../../features/account/domain/VpnAccess.ts';
const BASE = `${PRODUCTION_API_BASE}/auth/`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type VpnLoginAuth = { username: string; password: string };
export type RememberedIdentity = { accessToken: string; accountId: string; expiresAt: number; renewalToken?: string };
export class SessionChanged extends Error {}
export class SessionRejected extends Error {
  readonly sessionId?: string;
  constructor(message: string, sessionId?: string) { super(message); this.sessionId = sessionId; }
}
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
  #renewal: string | null = null;
  #renewing: Promise<void> | null = null;
  #logouts = new Map<string, Promise<void>>();
  #lastLogout?: Promise<void>;
  #expiresAt = 0;
  #accountId: string | null = null;
  #accountCache: Account | null = null;
  #accountRequest: { token: string; promise: Promise<Account> } | null = null;
  #accountRevision = 0;
  #activationRequest = false;
  #anonymousCreation: Promise<string> | null = null;
  #configurations = new Map<string, { config: string; expiresAt: number }>();
  #verifiedAccess: VpnAccess | null = null;
  #vpnAuthRequest: { token: string; promise: Promise<void> } | null = null;
  private readonly request: typeof fetch;
  private readonly rememberAccount?: (data: string, token: string) => Promise<void>;
  private readonly acceptAccess?: (access: VpnAccess, token: string) => Promise<void>;
  private readonly persistRenewal?: (identity: RememberedIdentity, expectedToken: string) => Promise<void>;
  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis), rememberAccount?: (data: string, token: string) => Promise<void>, acceptAccess?: (access: VpnAccess, token: string) => Promise<void>, persistRenewal?: (identity: RememberedIdentity, expectedToken: string) => Promise<void>) { this.persistRenewal = persistRenewal; this.request = request; this.rememberAccount = rememberAccount; this.acceptAccess = acceptAccess; }

  async authenticate(operation: 'login' | 'register' | 'account', email: string, password: string, accept?: (expiresAt: number, vpnAuth: VpnLoginAuth | null, identity: RememberedIdentity) => Promise<void>): Promise<number> {
    const revision = ++this.#accountRevision;
    if (operation === 'account' && !/^[0-9]{16}$/.test(email)) throw new Error('Enter all 16 digits.');
    let data: Record<string, unknown>;
    try {
      data = operation === 'account' ? await this.send('account-login', { account_number: email }) : await this.send(operation, { username: email, password });
    } catch (error) {
      if (revision !== this.#accountRevision) throw new SessionChanged('The login attempt was cancelled.');
      throw error;
    }
    if (revision !== this.#accountRevision) throw new SessionChanged('The login attempt was cancelled.');
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (typeof data.access_token !== 'string' || !/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/.test(data.access_token)
      || data.access_token.length > 256 || data.token_type !== 'Bearer'
      || typeof data.account_id !== 'string' || !/^[1-9][0-9]*$/.test(data.account_id)
      || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Stellar returned an invalid session. Please try again.');
    const renewalToken = data.renewal_token;
    if (renewalToken != null && (typeof renewalToken !== 'string' || !/^d1[a-f0-9]{32}\|[A-Za-z0-9]{64}$/.test(renewalToken))) throw new Error('Stellar returned an invalid session.');
    let vpnAuth: VpnLoginAuth | null = null;
    if (data.vpn_state === 'ready') {
      if (!object(data.vpn_auth) || typeof data.vpn_auth.username !== 'string' || !/^stvpn_[a-f0-9]{16}$/.test(data.vpn_auth.username)
        || typeof data.vpn_auth.password !== 'string' || !/^[a-f0-9]{32}$/.test(data.vpn_auth.password)) throw new Error('Stellar returned invalid VPN authentication. Please log in again.');
      vpnAuth = { username: data.vpn_auth.username, password: data.vpn_auth.password };
    } else if (data.vpn_auth != null) throw new Error('Stellar returned invalid VPN authentication.');
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    this.#token = data.access_token;
    this.#renewal = typeof renewalToken === 'string' ? renewalToken : null;
    this.#expiresAt = expiry;
    this.#accountId = data.account_id;
    // Native adapter consumes the one-time VPN secret; it is not returned to React state.
    try {
      if (accept) await accept(expiry, vpnAuth, { accessToken: data.access_token, accountId: data.account_id, expiresAt: expiry, ...(this.#renewal ? { renewalToken: this.#renewal } : {}) });
    } catch (error) {
      if (revision !== this.#accountRevision) throw new SessionChanged('The login attempt was cancelled.');
      throw error;
    }
    if (revision !== this.#accountRevision) throw new SessionChanged('The login attempt was cancelled.');
    return expiry;
  }

  /** Native main/tray windows share one vault; synchronize identity without revoking anything remotely. */
  synchronize(value: unknown): void {
    if (value === null) {
      if (this.#token === null && this.#renewal === null && this.#accountId === null) return;
      this.#accountRevision++; this.#token = null; this.#renewal = null; this.#expiresAt = 0; this.#accountId = null;
      this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
      return;
    }
    if (object(value) && value.accessToken === this.#token && value.accountId === this.#accountId
      && (value.renewalToken ?? null) === this.#renewal) return;
    this.#accountRevision++; this.restore(value);
  }
  private sessionRejected(): SessionRejected { return new SessionRejected(messages.invalid_session, (this.#renewal ?? this.#token)?.split('|')[0]); }
  get identityRevision(): number { return this.#accountRevision; }
  get sessionId(): string | undefined { return (this.#renewal ?? this.#token)?.split('|')[0]; }
  get active(): boolean { return this.#token !== null && this.#expiresAt > Date.now(); }
  get remembered(): boolean { return this.#renewal !== null; }
  async listDeviceSessions(after?: string) {
    const root = this.#renewal, revision = this.#accountRevision;
    if (!root) throw new Error('Please sign in once to enable secure remembered login.');
    if (after !== undefined && !validDeviceSessionId(after)) throw new Error('Invalid session identifier.');
    const data = await this.send('device-sessions', after === undefined ? {} : { after }, root);
    if (this.#renewal !== root || revision !== this.#accountRevision) throw new SessionChanged();
    return deviceLoginsPage(data, after);
  }
  async revokeDeviceSession(id: string): Promise<void> {
    const root = this.#renewal, revision = this.#accountRevision;
    if (!root) throw new Error('Please sign in once to enable secure remembered login.');
    if (!validDeviceSessionId(id) || id === root.split('|')[0]) throw new Error('Use Log out to remove this device.');
    const data = await this.send('device-revoke', { session_id: id }, root);
    if (this.#renewal !== root || revision !== this.#accountRevision) throw new SessionChanged();
    if (data.revoked !== true) throw new Error('Could not confirm session revocation.');
  }
  async rememberSession(): Promise<void> {
    if (this.remembered || !this.active) return;
    throw new Error('Please sign in once to enable secure remembered login.');
  }
  async renewSession(): Promise<void> {
    const root = this.#renewal, previous = this.#token, revision = this.#accountRevision;
    if (!root || !previous || this.#expiresAt > Date.now() + 30_000) return;
    if (this.#renewing) return this.#renewing;
    const pending = (async () => {
      const data = await this.send('renew', {}, root);
      if (this.#renewal !== root || this.#token !== previous || revision !== this.#accountRevision) throw new Error(messages.invalid_session);
      const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
      if (typeof data.access_token !== 'string' || !/^[1-9][0-9]{0,31}\|[A-Za-z0-9]{40}$/.test(data.access_token)
        || data.account_id !== this.#accountId || data.token_type !== 'Bearer' || !Number.isFinite(expiry)
        || expiry <= Date.now() || expiry > Date.now() + 86400_000 + 30_000) throw new Error('Stellar returned an invalid renewal.');
      const identity: RememberedIdentity = { accessToken: data.access_token, accountId: this.#accountId!, expiresAt: expiry, renewalToken: root };
      await this.persistRenewal?.(identity, previous);
      if (this.#renewal !== root || this.#token !== previous || revision !== this.#accountRevision) {
        if (this.#token === identity.accessToken && this.#renewal === root && this.#accountId === identity.accountId) return;
        throw new Error(messages.invalid_session);
      }
      this.#token = identity.accessToken; this.#expiresAt = expiry;
      this.#accountRequest = null; this.#configurations.clear();
    })();
    this.#renewing = pending;
    try { await pending; } finally { if (this.#renewing === pending) this.#renewing = null; }
  }

  createAnonymousAccount(): Promise<string> {
    // A creation is never retried automatically or turned into a login. Deduplicate double clicks.
    if (this.#anonymousCreation) return this.#anonymousCreation;
    const promise = this.send('account-create', {}).then(data => {
      if (typeof data.account_number !== 'string' || !/^[0-9]{16}$/.test(data.account_number)) {
        throw new Error('Stellar returned an invalid response.');
      }
      return data.account_number;
    });
    this.#anonymousCreation = promise;
    void promise.finally(() => { if (this.#anonymousCreation === promise) this.#anonymousCreation = null; }).catch(() => {});
    return promise;
  }

  async migrateLegacy(token: string, accept: (identity: RememberedIdentity) => Promise<void>): Promise<void> {
    if (this.#token !== null || !/^[1-9][0-9]{0,31}\|[A-Za-z0-9]{40}$/.test(token)) throw this.sessionRejected();
    const revision = ++this.#accountRevision;
    const data = await this.send('migrate-legacy', {}, token);
    if (revision !== this.#accountRevision || this.#token !== null) throw this.sessionRejected();
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (data.token_type !== 'Bearer' || data.access_token === token || !Number.isFinite(expiry)
      || expiry > Date.now() + 86400_000 + 30_000) throw new Error('Stellar returned an invalid migration session.');
    const identity = { accessToken: data.access_token, accountId: data.account_id, expiresAt: expiry };
    this.restore(identity);
    try {
      // Verify the issued session before making native login durable. No VPN password is imported.
      await this.verifyRestoredSession();
      if (revision !== this.#accountRevision || this.#token !== identity.accessToken) throw this.sessionRejected();
      await accept(identity as RememberedIdentity);
    } catch (error) {
      if (revision === this.#accountRevision && this.#token === identity.accessToken) {
        this.#token = null; this.#expiresAt = 0; this.#accountId = null;
      }
      // Do not revoke the replacement: a lost response or locked vault must be retryable.
      throw error;
    }
  }

  restore(value: unknown): void {
    if (!object(value) || typeof value.accessToken !== 'string' || !/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/.test(value.accessToken)
      || value.accessToken.length > 256 || typeof value.accountId !== 'string' || !/^[1-9][0-9]*$/.test(value.accountId)
      || (value.renewalToken != null && (typeof value.renewalToken !== 'string' || !/^d1[a-f0-9]{32}\|[A-Za-z0-9]{64}$/.test(value.renewalToken)))
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
      || (value.expiresAt <= Date.now() && value.renewalToken == null)) {
      throw this.sessionRejected();
    }
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    this.#token = value.accessToken; this.#accountId = value.accountId; this.#expiresAt = value.expiresAt;
    this.#renewal = typeof value.renewalToken === 'string' ? value.renewalToken : null;
  }
  cachedAccount(): Account | null { return (this.active || this.remembered) && this.#accountCache ? structuredClone(this.#accountCache) : null; }
  restoreAccountCache(data: unknown): Account | null {
    if ((!this.active && !this.remembered) || !this.#accountId || typeof data !== 'string' || data.length > 49_152) return null;
    try { this.#accountCache = { ...decodeAccount(JSON.parse(data), this.#accountId), cached: true }; return this.cachedAccount(); }
    catch { return null; }
  }

  async verifyRestoredSession(): Promise<void> {
    if (this.#renewal && this.#expiresAt <= Date.now() + 30_000) await this.renewSession();
    const token = this.#token;
    if (!this.active || !token) {
      if (this.remembered) throw new Error('Reconnect to Stellar to renew your session.');
      throw this.sessionRejected();
    }
    const data = await this.send('session', {}, token);
    if (token !== this.#token) return;
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (data.account_id !== this.#accountId || !Number.isFinite(expiry) || expiry <= Date.now()) {
      if (this.remembered) throw new Error('Stellar returned invalid session metadata. Please try again.');
      const rejection = this.sessionRejected();
      this.#renewal = null; this.#token = null; this.#expiresAt = 0; this.#accountId = null;
      this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
      throw rejection;
    }
    // Restoration must never extend the original token lifetime.
    this.#expiresAt = Math.min(this.#expiresAt, expiry);
  }

  async currentAccount(): Promise<Account> {
    if (this.#renewal && this.#expiresAt <= Date.now() + 30_000) await this.renewSession();
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
    if (this.#renewal && this.#expiresAt <= Date.now() + 30_000) await this.renewSession();
    const token = this.#token, revision = this.#accountRevision;
    if (!this.active || !token) {
      if (this.remembered) throw new Error('Reconnect to Stellar to renew your session.');
      throw this.sessionRejected();
    }
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
    if (this.#renewal && this.#expiresAt <= Date.now() + 30_000) await this.renewSession();
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
    if (this.#renewal && this.#expiresAt <= Date.now() + 30_000) await this.renewSession();
    const token = this.#token;
    if (!this.active || !token) {
      if (this.remembered) throw new Error('Reconnect to Stellar to renew your session.');
      throw this.sessionRejected();
    }
    if (!/^[A-Za-z0-9-]{4,128}$/.test(code)) throw new Error('Enter a valid activation code.');
    if (this.#activationRequest) throw new Error('Activation is already in progress.');
    this.#activationRequest = true;
    try {
      const data = await this.send('activation', { activation_code: code }, token);
      if (this.#token !== token || !this.active) throw this.sessionRejected();
      if (data.activated !== true) throw new Error('Activation could not be confirmed. Retry the same code to resume safely.');
      this.#accountRevision++; this.#accountRequest = null;
    } finally { this.#activationRequest = false; }
  }

  async revokeRememberedCredential(root: string): Promise<void> {
    if (!/^d1[a-f0-9]{32}\|[A-Za-z0-9]{64}$/.test(root)) throw new Error('Invalid revocation credential.');
    await this.send('device-logout', {}, root);
  }
  logout(expectedSessionId?: string): Promise<void> {
    const id = expectedSessionId ?? this.sessionId;
    if (id && this.#logouts.has(id)) return this.#logouts.get(id)!;
    if (!id) {
      if (this.#lastLogout) return this.#lastLogout;
      // Cancel a pending legacy exchange even before it has adopted an identity.
      this.#accountRevision++;
      return Promise.resolve();
    }
    if (expectedSessionId && this.sessionId !== expectedSessionId) return Promise.reject(new Error('The session changed. Please try again.'));
    const token = this.#token, root = this.#renewal;
    this.#accountRevision++;
    this.#renewal = null; this.#token = null; this.#expiresAt = 0; this.#accountId = null;
    this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear();
    const pending = (async () => {
      if (root) await this.send('device-logout', {}, root);
      else if (token) await this.send('logout', {}, token);
    })();
    this.#logouts.set(id, pending); this.#lastLogout = pending;
    void pending.finally(() => {
      if (this.#logouts.get(id) === pending) this.#logouts.delete(id);
      if (this.#lastLogout === pending) this.#lastLogout = undefined;
    }).catch(() => {});
    return pending;
  }

  private async send(operation: 'device-sessions' | 'device-revoke' | 'remember' | 'renew' | 'device-logout' | 'login' | 'register' | 'account-login' | 'account-create' | 'migrate-legacy' | 'logout' | 'account' | 'configuration' | 'session' | 'activation' | 'vpn-auth', body: Record<string, string>, token?: string): Promise<Record<string, unknown>> {
    const bucket = operation === 'account-create' ? 'creation' : ['login', 'register', 'account-login', 'migrate-legacy'].includes(operation) ? 'credentials' : 'session';
    const limitMessage = operation === 'account-create' ? 'Too many attempts. Please try again later.'
      : operation === 'configuration' ? 'Location requests are temporarily limited. Wait a moment before switching again.'
      : bucket === 'credentials' ? 'Sign-in requests are temporarily limited. Please wait before trying again.'
      : 'Account updates are temporarily limited. Please wait before refreshing.';
    if ((this.#rateLimits.get(bucket) ?? 0) > Date.now()) throw new Error(limitMessage);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ['renew', 'remember', 'device-logout'].includes(operation) ? 5_000 : 30_000);
    let data: unknown, status = 0;
    try {
      const response = await apiRequest(this.request, operation === 'renew' ? BASE + 'renew' : operation === 'device-logout' ? BASE + 'device-logout' : operation === 'account-create' ? ANONYMOUS_SIGNUP_URL : operation === 'vpn-auth' ? `${PRODUCTION_API_BASE}/vpn/auth` : operation === 'activation' ? `${PRODUCTION_API_BASE}/account/activation` : operation === 'account' ? `${PRODUCTION_API_BASE}/account` : operation === 'configuration' ? `${PRODUCTION_API_BASE}/vpn/configuration` : BASE + operation, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }, ['account', 'configuration', 'session', 'renew', 'remember'].includes(operation), undefined, () => operation === 'migrate-legacy' || operation === 'logout' || operation === 'device-logout' || !token || this.#token === token || this.#renewal === token);
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
      if (operation === 'account-create') throw new Error('Account creation could not be confirmed. Check your connection before trying again.');
      throw new Error('Could not reach Stellar. Check your connection and try again.');
    } finally { clearTimeout(timer); }
    if (!object(data) || !object(data.meta) || data.meta.api_version !== 'v2') throw new Error('Stellar returned an invalid response.');
    if (status !== 200) {
      if (status === 429) throw new Error(limitMessage);
      if (operation === 'account-create') throw new Error('Account creation is temporarily unavailable. Please try again later.');
      const code = object(data.error) && typeof data.error.code === 'string' ? data.error.code : '';
      if (operation === 'device-logout' && status === 401 && code === 'invalid_session') return { revoked: true };
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
      // Only an explicit session rejection may erase a protected login. A 403
      // from origin/access policy or a service-auth failure still blocks this
      // operation, but does not establish that the user's token was revoked.
      if (operation !== 'remember' && token && [401, 403].includes(status) && ['invalid_session', 'unauthenticated'].includes(code)) {
        if (operation !== 'renew' && this.#renewal && this.#token === token) {
          // An access-token rejection does not prove the device login was revoked.
          // Ask the dedicated renewal endpoint; only its rejection removes that login.
          this.#expiresAt = 0;
          await this.renewSession();
          throw new Error('Your session was renewed. Please try again.');
        }
        // A late rejection from an older login must not revoke a newer one.
        if (this.#token !== token && this.#renewal !== token) throw new Error(messages.invalid_session);
        if (this.#token === token || this.#renewal === token) { this.#renewal = null; this.#token = null; this.#expiresAt = 0; this.#accountId = null; this.#accountCache = null; this.#accountRequest = null; this.#configurations.clear(); }
        throw new SessionRejected(messages.invalid_session, token.split('|')[0]);
      }
      if (code === 'integration_unavailable' && operation === 'account') throw new Error('Couldn’t update your account.');
      if (code === 'integration_unavailable' && operation === 'configuration') throw new Error('Couldn’t load this VPN location. Please try again.');
      throw new Error(messages[code] || 'The request could not be completed. Please try again.');
    }
    if (!object(data.data)) throw new Error('Stellar returned an invalid response.');
    if ((operation === 'logout' || operation === 'device-logout') && data.data.revoked !== true) throw new Error('Could not confirm session revocation. Your local session has been cleared.');
    return data.data;
  }
}
