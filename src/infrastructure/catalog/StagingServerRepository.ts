import { normalizeServers, type ServerRepository, type Server } from '../../features/locations/domain/Server.ts';

// Only public fixture data. This adapter never sends account/session credentials.
export const STAGING_CATALOG_URL = 'https://stellar-desktop-vpn-staging-ayakcqbcfvb2fqhc.westeurope-01.azurewebsites.net/api/v2/servers';
const MAX_BYTES = 512 * 1024;
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
  constructor(request: typeof fetch = globalThis.fetch.bind(globalThis)) { this.request = request; }
  async list(signal?: AbortSignal): Promise<Server[]> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, 30_000);
    try {
      const response = await this.request(STAGING_CATALOG_URL, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error('Catalog unavailable');
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
      return decodeStagingCatalog(JSON.parse(text));
    } catch {
      // No silent bundled fallback and no server response/exception details in UI.
      throw new Error('Could not load test locations from Stellar staging. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
