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
  const { ISO_A2, WB_A2, ADM0_A3 } = feature.properties;
  if (/^[A-Z]{2}$/.test(ISO_A2 || '')) return ISO_A2;
  // Natural Earth leaves these ISO fields at -99; postal N/F are not ISO codes.
  if (ADM0_A3 === 'NOR') return 'NO';
  if (ADM0_A3 === 'FRA') return 'FR';
  return /^[A-Z]{2}$/.test(WB_A2 || '') ? WB_A2 : '';
}
/** Natural Earth groups French Guiana with France; the VPN map needs separate ISO territories. */
export function countryMapFeatures(feature: CountryFeature): CountryFeature[] {
  if (countryCode(feature) !== 'FR' || feature.geometry?.type !== 'MultiPolygon') return [feature];
  return (feature.geometry.coordinates as Ring[][]).map(coordinates => {
    const guiana = coordinates[0]?.length > 0 && coordinates[0].every(([lon, lat]) => lon >= -55 && lon <= -50 && lat >= 0 && lat <= 7);
    return {
      properties: guiana ? { ...feature.properties, ISO_A2: 'GF', WB_A2: 'GF', ADM0_A3: 'GUF', ADMIN: 'French Guiana', NAME: 'French Guiana' } : feature.properties,
      geometry: { type: 'Polygon', coordinates },
    };
  });
}
export function routeCurve(from: Coordinate, to: Coordinate) {
  const a = mapPoint(from), b = mapPoint(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.min(95, Math.max(42, distance * .24));
  return `M${a.x} ${a.y} Q${(a.x + b.x) / 2 - dy / distance * bend} ${(a.y + b.y) / 2 + dx / distance * bend} ${b.x} ${b.y}`;
}
