export interface Server {
  id: string;
  country: string;
  countryCode: string;
  city: string;
  flag: string;
  lon: number;
  lat: number;
}
export interface ServerRepository { list(signal?: AbortSignal): Promise<Server[]> }
export function normalizeServers(data: unknown): Server[] {
  if (!Array.isArray(data)) throw new Error('Invalid server catalog');
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const ids = new Set<string>();
  return data.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid server');
    const source = item as Record<string, unknown>;
    const { id, name, country, lat, lon } = source;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || ids.has(id)
      || typeof name !== 'string' || typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)
      || typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error('Invalid server catalog entry');
    }
    ids.add(id);
    const [sourceCountry, city] = name.split(/\s+[–-]\s+/, 2);
    return { id, countryCode: country, country: names.of(country) || sourceCountry,
      city: city || sourceCountry, lat, lon,
      flag: [...country].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('') };
  });
}
export function filterServers(servers: readonly Server[], query: string, favorites: readonly string[] | null): Server[] {
  const search = query.trim().toLocaleLowerCase('en');
  return servers.filter(server => (!favorites || favorites.includes(server.id))
    && `${server.country} ${server.city}`.toLocaleLowerCase('en').includes(search))
    .sort((a, b) => a.country.localeCompare(b.country, 'en') || a.city.localeCompare(b.city, 'en'));
}
