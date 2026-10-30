import { normalizeServers, type ServerRepository, type Server } from '../../features/locations/domain/Server.ts';
import { STAGING_API_BASE } from '../config/Staging.ts';
import { apiRequest } from '../http/ApiRetry.ts';

// Only public fixture data. This adapter never sends account/session credentials.
export const STAGING_CATALOG_URL = `${STAGING_API_BASE}/servers`;
const MAX_BYTES = 512 * 1024;
const CACHE_KEY = 'stellar.server-catalog.v1';
type CatalogStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): CatalogStorage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function decodeStagingCatalog(value: unknown): Server[] {
  if (!object(value) || !object(value.meta) || value.meta.api_version !== 'v2' || value.meta.mode !== 'fixture'
    || !Array.isArray(value.data) || !value.data.length || value.data.length > 1000) throw new Error('Invalid staging catalog');
  return normalizeServers(value.data.map((entry: unknown) => {
    if (!object(entry) || !object(entry.coordinates) || typeof entry.name !== 'string' || entry.name.length > 200) throw new Error('Invalid staging server');
    return { id: entry.id, name: entry.name, country: entry.country_code,
      lat: entry.coordinates.latitude, lon: entry.coordinates.longitude };
  }));
}

export class StagingServerRepository implements ServerRepository {
  private readonly request: typeof fetch;
  private readonly storage: CatalogStorage | undefined;
  private memory: Server[] = [];
  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis), storage: CatalogStorage | undefined = browserStorage()) { this.request = request; this.storage = storage; }
  cached(): Server[] {
    try {
      const raw = this.storage?.getItem(CACHE_KEY);
      if (raw && raw.length <= MAX_BYTES) {
        const value: unknown = JSON.parse(raw);
        if (object(value) && value.version === 1 && value.source === STAGING_CATALOG_URL
          && Array.isArray(value.servers) && value.servers.length > 0 && value.servers.length <= 1000
          && value.servers.every(row => object(row) && typeof row.name === 'string' && row.name.length <= 200)) {
          this.memory = normalizeServers(value.servers);
        }
      }
    } catch { /* Corrupt/unavailable storage must not erase the in-memory list. */ }
    return this.memory.map(server => ({ ...server }));
  }
  private remember(servers: Server[]): void {
    this.memory = servers.map(server => ({ ...server }));
    // Deliberate allowlist: never persist an upstream object containing configs,
    // credentials, tokens or account identifiers alongside public locations.
    const value = { version: 1, source: STAGING_CATALOG_URL, servers: servers.map(server => ({
      id: server.id, name: `${server.country} – ${server.city}`, country: server.countryCode, lat: server.lat, lon: server.lon,
    })) };
    try { this.storage?.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* Storage quota/private mode still permits the current list. */ }
  }
  async list(signal?: AbortSignal): Promise<Server[]> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, 30_000);
    try {
      const response = await apiRequest(this.request, STAGING_CATALOG_URL, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      }, true);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) { await response.body?.cancel(); throw new Error('Catalog unavailable'); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error('Catalog too large');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); reader.releaseLock(); }
      const servers = decodeStagingCatalog(JSON.parse(text));
      if (controller.signal.aborted) throw new Error('Cancelled');
      this.remember(servers);
      return servers;
    } catch {
      // No silent bundled fallback and no server response/exception details in UI.
      throw new Error('Could not load test locations from Stellar staging. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
