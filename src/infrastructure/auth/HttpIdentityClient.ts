const BASE = 'https://stellar-desktop-vpn-staging-ayakcqbcfvb2fqhc.westeurope-01.azurewebsites.net/api/v2/auth/';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const messages: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  invalid_session: 'Your session has expired. Please log in again.',
  registration_unavailable: 'Could not create this account. Try logging in instead.',
  invalid_input: 'Please check your email and password.',
  validation_failed: 'Please check your email and password. New passwords need at least 12 characters.',
  rate_limited: 'Too many attempts. Please try again later.',
  integration_unavailable: 'Stellar account sign-in is temporarily unavailable. Please try again shortly.',
};

/** Volatile session only: never persists credentials, tokens or authenticated state. */
export class HttpIdentityClient {
  #token: string | null = null;
  #expiresAt = 0;
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis)) { this.request = request; }

  async authenticate(operation: 'login' | 'register', email: string, password: string): Promise<number> {
    const data = await this.send(operation, { username: email, password });
    const expiry = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (typeof data.access_token !== 'string' || !/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/.test(data.access_token)
      || data.access_token.length > 256 || data.token_type !== 'Bearer'
      || typeof data.account_id !== 'string' || !/^[1-9][0-9]*$/.test(data.account_id)
      || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Stellar returned an invalid session. Please try again.');
    this.#token = data.access_token;
    this.#expiresAt = expiry;
    return expiry;
  }

  get active(): boolean { return this.#token !== null && this.#expiresAt > Date.now(); }

  async logout(): Promise<void> {
    const token = this.#token;
    // Always clear local access, including when offline revocation fails.
    this.#token = null; this.#expiresAt = 0;
    if (token) await this.send('logout', {}, token);
  }

  private async send(operation: 'login' | 'register' | 'logout', body: Record<string, string>, token?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let data: unknown, status = 0;
    try {
      const response = await this.request(BASE + operation, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      status = response.status;
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) throw new Error();
          text += decoder.decode(chunk.value, { stream: true });
        }
        data = JSON.parse(text + decoder.decode());
      } finally { await reader.cancel(); reader.releaseLock(); }
    } catch {
      throw new Error('Could not reach Stellar. Check your connection and try again.');
    } finally { clearTimeout(timer); }
    if (!object(data) || !object(data.meta) || data.meta.api_version !== 'v2') throw new Error('Stellar returned an invalid response.');
    if (status !== 200) {
      const code = object(data.error) && typeof data.error.code === 'string' ? data.error.code : '';
      throw new Error(messages[code] || 'The request could not be completed. Please try again.');
    }
    if (!object(data.data)) throw new Error('Stellar returned an invalid response.');
    if (operation === 'logout' && data.data.revoked !== true) throw new Error('Could not confirm session revocation. Your local session has been cleared.');
    return data.data;
  }
}
