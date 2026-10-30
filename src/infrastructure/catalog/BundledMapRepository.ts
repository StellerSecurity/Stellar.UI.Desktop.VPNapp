import sourceUrl from '../../../assets/world-countries.geojson?url';
import type { WorldMap } from '../../features/map/domain/geometry';
let cached: WorldMap | undefined;
export async function loadWorldMap(signal?: AbortSignal): Promise<WorldMap> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (cached) return cached;
  const response = await fetch(sourceUrl, { signal });
  if (!response.ok) throw new Error('The world map could not be loaded.');
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('features' in data) || !Array.isArray(data.features)) throw new Error('Invalid world map.');
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  cached = data as WorldMap;
  return cached;
}
