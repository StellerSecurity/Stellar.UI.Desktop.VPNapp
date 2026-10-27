export interface Point { x: number; y: number }
export interface Coordinate { lon: number; lat: number }
export type Ring = number[][];
export interface Geometry { type: string; coordinates: Ring[] | Ring[][] }
export interface CountryFeature { properties: Record<string, string>; geometry: Geometry | null }
export interface WorldMap { type: string; features: CountryFeature[] }
export function mapPoint(point: Coordinate): Point {
  return { x: (point.lon + 180) / 360 * 1100, y: 85 + (90 - point.lat) / 180 * 590 };
}
export function placement(point: Coordinate) {
  const projected = mapPoint(point);
  return { left: `${projected.x / 11}%`, top: `${projected.y / 7.6}%` };
}
function polygonPath(coordinates: Ring[]): string {
  return coordinates.map(ring => ring.map(([lon, lat], index) => {
    const point = mapPoint({ lon, lat });
    return `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(' ') + ' Z').join(' ');
}
export function geometryToPath(geometry: Geometry | null): string {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return polygonPath(geometry.coordinates as Ring[]);
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).map(polygonPath).join(' ');
  return '';
}
export function countryCode(feature: CountryFeature) {
  const { ISO_A2, POSTAL, ADM0_A3 } = feature.properties;
  return ISO_A2 && ISO_A2 !== '-99' ? ISO_A2 : POSTAL || ADM0_A3 || '';
}
export function routeCurve(from: Coordinate, to: Coordinate) {
  const a = mapPoint(from), b = mapPoint(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.min(95, Math.max(42, distance * .24));
  return `M${a.x} ${a.y} Q${(a.x + b.x) / 2 - dy / distance * bend} ${(a.y + b.y) / 2 + dx / distance * bend} ${b.x} ${b.y}`;
}
