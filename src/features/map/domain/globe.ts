import type { Coordinate, Geometry, Ring } from './geometry.ts';

const radians = Math.PI / 180;
export interface GlobePoint { x: number; y: number; z: number }
/** Orthographic projection: z is depth, so back-facing locations are not clickable. */
export function globePoint(point: Coordinate, centre: Coordinate): GlobePoint {
  const lat = point.lat * radians, delta = (point.lon - centre.lon) * radians, tilt = centre.lat * radians;
  return { x: Math.cos(lat) * Math.sin(delta),
    y: Math.sin(tilt) * Math.cos(lat) * Math.cos(delta) - Math.cos(tilt) * Math.sin(lat),
    z: Math.sin(tilt) * Math.sin(lat) + Math.cos(tilt) * Math.cos(lat) * Math.cos(delta) };
}
function horizon(a: GlobePoint, b: GlobePoint): GlobePoint {
  const t = a.z / (a.z - b.z), x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length, z: 0 };
}
const position = (p: GlobePoint) => `${(250 + p.x * 240).toFixed(2)} ${(250 + p.y * 240).toFixed(2)}`;
function ringPath(ring: Ring, centre: Coordinate): string {
  const points = ring.map(([lon, lat]) => globePoint({ lon, lat }, centre));
  if (points.length < 3) return '';
  const first = points.findIndex(p => p.z >= 0);
  if (first < 0) return '';
  // Start on the visible hemisphere; connect clipped runs along the sphere's limb,
  // not straight chords through the ocean or back-facing country coordinates.
  let path = `M${position(points[first])}`, exit: GlobePoint | null = null;
  for (let i = 1; i <= points.length; i++) {
    const a = points[(first + i - 1) % points.length], b = points[(first + i) % points.length];
    if (a.z >= 0 && b.z >= 0) path += `L${position(b)}`;
    else if (a.z >= 0) { exit = horizon(a, b); path += `L${position(exit)}`; }
    else if (b.z >= 0) {
      const entry = horizon(a, b);
      if (exit) {
        let delta = Math.atan2(entry.y, entry.x) - Math.atan2(exit.y, exit.x);
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        path += `A240 240 0 0 ${delta >= 0 ? 1 : 0} ${position(entry)}`;
      }
      path += `L${position(b)}`; exit = null;
    }
  }
  return `${path}Z`;
}
export function globePath(geometry: Geometry | null, centre: Coordinate): string {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return (geometry.coordinates as Ring[]).map(ring => ringPath(ring, centre)).join('');
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).flatMap(polygon => polygon.map(ring => ringPath(ring, centre))).join('');
  return '';
}
export function rotateGlobe(centre: Coordinate, dx: number, dy: number): Coordinate {
  return { lon: ((centre.lon - dx * .35 + 180) % 360 + 360) % 360 - 180, lat: Math.max(-80, Math.min(80, centre.lat + dy * .35)) };
}
/** Exponential friction integrated over time: equal feel at 60 Hz and 120 Hz. */
export function globeGlide(vx: number, vy: number, milliseconds: number) {
  const rate = -Math.log(.935) / 16.67, dt = Math.max(0, Math.min(32, milliseconds)), decay = Math.exp(-rate * dt);
  return { dx: vx * (1 - decay) / rate, dy: vy * (1 - decay) / rate, vx: vx * decay, vy: vy * decay };
}
