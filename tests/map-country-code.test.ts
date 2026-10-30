import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countryCode, countryMapFeatures, type Ring, type WorldMap } from '../src/features/map/domain/geometry.ts';

const map = JSON.parse(readFileSync(new URL('../assets/world-countries.geojson', import.meta.url), 'utf8')) as WorldMap;
test('Paris highlights metropolitan France and Corsica, never French Guiana', () => {
  const original = map.features.find(feature => feature.properties.ADMIN === 'France')!;
  const unchanged = JSON.stringify(original);
  const parts = countryMapFeatures(original);
  const france = parts.filter(part => countryCode(part) === 'FR');
  const guiana = parts.filter(part => countryCode(part) === 'GF');
  assert.equal(france.length, 2);
  assert.equal(guiana.length, 1);
  for (const part of france) {
    for (const [lon, lat] of (part.geometry!.coordinates as Ring[]).flat()) assert.ok(lon > -6 && lat > 40);
  }
  assert.equal(guiana[0].properties.ADMIN, 'French Guiana');
  assert.equal(JSON.stringify(original), unchanged);
});
test('bundled Norway and France geometry matches the server ISO codes', () => {
  for (const [name, code] of [['Norway', 'NO'], ['France', 'FR'], ['Denmark', 'DK']]) {
    const feature = map.features.find(feature => feature.properties.ADMIN === name);
    assert.ok(feature, name);
    assert.equal(countryCode(feature), code);
  }
});
test('non-ISO postal abbreviations cannot highlight unrelated server countries', () => {
  for (const name of ['Northern Cyprus', 'Somaliland']) {
    const feature = map.features.find(feature => feature.properties.ADMIN === name);
    assert.ok(feature);
    assert.equal(countryCode(feature), '');
  }
});
