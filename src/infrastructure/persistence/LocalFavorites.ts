import { BrowserPreferences } from './BrowserPreferences';
const defaults = ['cz-1', 'dk-1', 'ch-1'];
/** Non-secret location IDs only; no account/session or VPN auth state. */
export class LocalFavorites {
  private readonly storage = new BrowserPreferences();
  load(): string[] {
    const value: unknown = this.storage.read('favorite-locations-v1', defaults);
    return Array.isArray(value) && value.length <= 1000 && value.every(id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id))
      ? [...new Set(value)] : [...defaults];
  }
  save(ids: string[]): void {
    if (ids.length <= 1000 && ids.every(id => /^[a-z0-9-]{1,64}$/.test(id))) this.storage.write('favorite-locations-v1', [...new Set(ids)]);
  }
}
