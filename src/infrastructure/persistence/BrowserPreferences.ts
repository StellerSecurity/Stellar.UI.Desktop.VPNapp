/** Non-secret preview preferences only. Real credentials must never enter localStorage. */
export class BrowserPreferences {
  read<T>(key: string, fallback: T): T {
    try { const value = localStorage.getItem(`stellar-vpn-${key}`); return value === null ? fallback : JSON.parse(value) as T; }
    catch { return fallback; }
  }
  write(key: string, value: unknown) {
    try { localStorage.setItem(`stellar-vpn-${key}`, JSON.stringify(value)); }
    catch { /* Preferences remain usable in memory when browser storage is unavailable. */ }
  }
}
