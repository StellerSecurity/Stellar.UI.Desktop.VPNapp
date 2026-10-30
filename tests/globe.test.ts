import test from 'node:test';
import assert from 'node:assert/strict';
import { globeGlide, globePoint, globePath, rotateGlobe } from '../src/features/map/domain/globe.ts';
test('globe projection centres the selected longitude and latitude, and hides the opposite hemisphere', () => {
  const centre = { lon: 12, lat: 55 };
  const selected = globePoint(centre, centre);
  assert.ok(Math.abs(selected.x) < 1e-9 && Math.abs(selected.y) < 1e-9);
  assert.ok(selected.z > .999);
  assert.ok(globePoint({ lon: -168, lat: -55 }, centre).z < -.999);
});
test('country paths clip crossings to the round horizon instead of drawing the back hemisphere', () => {
  const centre = { lon: 0, lat: 0 };
  assert.equal(globePath({ type: 'Polygon', coordinates: [[[150, 10], [160, 20], [170, 10], [150, 10]]] }, centre), '');
  const clipped = globePath({ type: 'Polygon', coordinates: [[[70, 10], [110, 10], [110, -10], [70, -10], [70, 10]]] }, centre);
  assert.match(clipped, /A240 240/);
  assert.doesNotMatch(clipped, /NaN|Infinity/);
  assert.ok(clipped.endsWith('Z'));
  assert.equal(globePath(null, centre), '');
});
test('globe rotation wraps longitude, constrains tilt and stays finite across repeated full turns', () => {
  const point = rotateGlobe({ lon: 179, lat: 78 }, -4000, 1000);
  assert.ok(point.lon >= -180 && point.lon < 180);
  assert.equal(point.lat, 80);
  assert.equal(rotateGlobe(point, 0, -1000).lat, -80);
});
test('globe drag inertia decays smoothly with frame-rate-independent distance and bounded resume steps', () => {
  const once = globeGlide(1, -.5, 32), half = globeGlide(1, -.5, 16), twice = globeGlide(half.vx, half.vy, 16);
  assert.ok(once.vx > 0 && once.vx < 1);
  assert.ok(Math.abs(half.dx + twice.dx - once.dx) < 1e-9);
  assert.ok(Math.abs(twice.vx - once.vx) < 1e-9);
  assert.deepEqual(globeGlide(1, -.5, 10000), once);
  assert.equal(globeGlide(0, 0, 16).dx, 0);
});
