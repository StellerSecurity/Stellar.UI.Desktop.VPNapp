import type { Coordinate } from './geometry.ts';
import { globePoint } from './globe.ts';

export interface GlobeLocation extends Coordinate { id: string }
/** Keep geographic anchors truthful; declutter flags, not the underlying locations. */
export function globeMarkers<T extends GlobeLocation>(locations: T[], centre: Coordinate, radius: number, securedId?: string | null, selectedId?: string, previousFlags: ReadonlySet<string> = new Set()) {
  const visible = locations.map(location => ({ location, point: globePoint(location, centre), flag: false })).filter(marker => marker.point.z >= .05);
  const rank = (id: string) => id === securedId ? 4 : id === selectedId ? 3 : previousFlags.has(id) ? 2 : 1;
  const ordered = [...visible].sort((a, b) => rank(b.location.id) - rank(a.location.id) || b.point.z - a.point.z || a.location.id.localeCompare(b.location.id));
  const flags: typeof visible = [];
  for (const marker of ordered) {
    marker.flag = !flags.some(other => Math.abs(marker.point.x - other.point.x) * radius < 32 && Math.abs(marker.point.y - other.point.y) * radius < 26);
    if (marker.flag) flags.push(marker);
  }
  return visible;
}
