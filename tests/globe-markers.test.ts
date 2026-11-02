import test from 'node:test';
import assert from 'node:assert/strict';
import { globeMarkers } from '../src/features/map/domain/globeMarkers.ts';
const centre = { lon: 12, lat: 55 };
const locations = [{ id: 'dk', lon: 12.5, lat: 55.7 }, { id: 'de', lon: 8.7, lat: 50.1 }, { id: 'nl', lon: 4.9, lat: 52.3 }, { id: 'au', lon: 151, lat: -33 }, { id: 'es', lon: -3.7, lat: 40.4 }];
test('globe decluttering keeps all front-facing locations but reserves clear flags around the connected location', () => {
  const markers = globeMarkers(locations, centre, 160, 'dk', 'de');
  assert.equal(markers.length, 4);
  assert.equal(markers.find(marker => marker.location.id === 'dk')?.flag, true);
  assert.equal(markers.find(marker => marker.location.id === 'de')?.flag, false);
  assert.ok(markers.some(marker => !marker.flag));
  const flags = markers.filter(marker => marker.flag);
  for (const a of flags) for (const b of flags) if (a !== b) assert.ok(Math.abs(a.point.x - b.point.x) * 160 >= 32 || Math.abs(a.point.y - b.point.y) * 160 >= 26);
});
test('decluttering does not invent or displace geographic anchors, and keeps previous flags stable', () => {
  const first = globeMarkers(locations, centre, 260, 'dk');
  const remembered = new Set(first.filter(marker => marker.flag).map(marker => marker.location.id));
  const again = globeMarkers(locations, centre, 260, 'dk', undefined, remembered);
  assert.deepEqual(again, first);
  assert.ok(first.every(marker => locations.includes(marker.location)));
  assert.equal(first.find(marker => marker.location.id === 'au'), undefined);
});
