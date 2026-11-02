import type { Coordinate, Geometry, Ring } from './geometry.ts';
import { mapPoint } from './geometry.ts';
import { globePoint, type GlobePoint } from './globe.ts';

export interface MorphCamera { centre: Coordinate; sphere: { x: number; y: number; radius: number }; plane: { left: number; top: number; width: number; height: number } }
export interface MorphVertex { sx: number; sy: number; fx: number; fy: number }
interface Sample { coordinate: Coordinate; view: GlobePoint }
const radians = Math.PI / 180;
function inverse(view: GlobePoint, centre: Coordinate): Coordinate {
  const tilt = centre.lat * radians;
  const lat = Math.asin(Math.max(-1, Math.min(1, -Math.cos(tilt) * view.y + Math.sin(tilt) * view.z))) / radians;
  const lon = centre.lon + Math.atan2(view.x, Math.sin(tilt) * view.y + Math.cos(tilt) * view.z) / radians;
  return { lat, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
}
function crossing(a: Sample, b: Sample, centre: Coordinate): Sample {
  const t = a.view.z / (a.view.z - b.view.z), x = a.view.x + (b.view.x - a.view.x) * t, y = a.view.y + (b.view.y - a.view.y) * t;
  const radius = Math.hypot(x, y) || 1, view = { x: x / radius, y: y / radius, z: 0 };
  return { coordinate: inverse(view, centre), view };
}
/** Clip once and retain matching vertices in both projections throughout a gesture. */
function clipped(ring: Ring, centre: Coordinate): Sample[] {
  const samples = ring.map(([lon, lat]) => ({ coordinate: { lon, lat }, view: globePoint({ lon, lat }, centre) }));
  const start = samples.findIndex(p => p.view.z >= 0);
  if (start < 0 || samples.length < 3) return [];
  const result = [samples[start]]; let exit: Sample | undefined;
  for (let i = 1; i <= samples.length; i++) {
    const a = samples[(start + i - 1) % samples.length], b = samples[(start + i) % samples.length];
    if (a.view.z >= 0 && b.view.z >= 0) result.push(b);
    else if (a.view.z >= 0) { exit = crossing(a, b, centre); result.push(exit); }
    else if (b.view.z >= 0) {
      const entry = crossing(a, b, centre);
      if (exit) {
        const angle = Math.atan2(exit.view.y, exit.view.x);
        const raw = Math.atan2(entry.view.y, entry.view.x) - angle;
        const delta = Math.atan2(Math.sin(raw), Math.cos(raw)), steps = Math.max(1, Math.ceil(Math.abs(delta) / .06));
        for (let step = 1; step <= steps; step++) {
          const theta = angle + delta * step / steps, view = { x: Math.cos(theta), y: Math.sin(theta), z: 0 };
          result.push({ coordinate: inverse(view, centre), view });
        }
      }
      result.push(b); exit = undefined;
    }
  }
  return result;
}
export function morphVertex(coordinate: Coordinate, camera: MorphCamera, view = globePoint(coordinate, camera.centre)): MorphVertex {
  const flat = mapPoint(coordinate);
  return { sx: camera.sphere.x + view.x * camera.sphere.radius, sy: camera.sphere.y + view.y * camera.sphere.radius,
    fx: camera.plane.left + flat.x / 1100 * camera.plane.width, fy: camera.plane.top + flat.y / 760 * camera.plane.height };
}
export function morphGeometry(geometry: Geometry | null, camera: MorphCamera): MorphVertex[][] {
  if (!geometry) return [];
  const rings = geometry.type === 'Polygon' ? geometry.coordinates as Ring[]
    : geometry.type === 'MultiPolygon' ? (geometry.coordinates as Ring[][]).flat() : [];
  return rings.map(ring => clipped(ring, camera.centre).map(sample => morphVertex(sample.coordinate, camera, sample.view))).filter(ring => ring.length > 2);
}
export function morphPosition(vertex: MorphVertex, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  return { x: vertex.sx + (vertex.fx - vertex.sx) * p, y: vertex.sy + (vertex.fy - vertex.sy) * p };
}
export function morphPath(rings: MorphVertex[][], progress: number): string {
  return rings.map(ring => ring.map((vertex, index) => {
    const { x, y } = morphPosition(vertex, progress);
    return `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join('') + 'Z').join('');
}
/** Complementary geometry prevents off-horizon countries popping in at handoff. */
export function flatBackPath(geometry: Geometry | null, camera: MorphCamera): string {
  return morphPath(morphGeometry(geometry, { ...camera, centre: { lon: camera.centre.lon + 180, lat: -camera.centre.lat } }), 1);
}
export function peripheralReveal(progress: number): number {
  const p = Math.max(0, Math.min(1, (progress - .35) / .5));
  return p * p * (3 - 2 * p);
}
/** Exact critically damped step, preserving velocity when the user reverses. */
export function projectionSpring(position: number, velocity: number, target: number, milliseconds: number) {
  const dt = Math.max(0, Math.min(64, milliseconds)) / 1000, omega = 30;
  const error = position - target, tangent = velocity + omega * error, decay = Math.exp(-omega * dt);
  return { position: target + (error + tangent * dt) * decay, velocity: (velocity - omega * tangent * dt) * decay };
}
