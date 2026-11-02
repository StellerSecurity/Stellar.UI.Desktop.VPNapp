import test from 'node:test';
import assert from 'node:assert/strict';
import { flatBackPath, morphGeometry, morphPath, morphPosition, morphVertex, peripheralReveal, projectionSpring, type MorphCamera } from '../src/features/map/domain/projectionMorph.ts';
import { mapPoint } from '../src/features/map/domain/geometry.ts';
const camera: MorphCamera = { centre: { lon: 12, lat: 55 }, sphere: { x: 500, y: 300, radius: 200 }, plane: { left: -350, top: -200, width: 2000, height: 2000 * 760 / 1100 } };
test('one geographic vertex lands exactly on both the sphere and the flat-map coordinates, including flag anchors', () => {
  const point = { lon: 12, lat: 55 }, vertex = morphVertex(point, camera), flat = mapPoint(point);
  assert.deepEqual(morphPosition(vertex, 0), { x: 500, y: 300 });
  const end = morphPosition(vertex, 1);
  assert.ok(Math.abs(end.x - (camera.plane.left + flat.x / 1100 * camera.plane.width)) < 1e-9);
  assert.ok(Math.abs(end.y - (camera.plane.top + flat.y / 760 * camera.plane.height)) < 1e-9);
  const middle = morphPosition(vertex, .5);
  assert.equal(middle.x, (500 + end.x) / 2);
});
test('clipped country vertices retain their topology through the projection change', () => {
  const model = morphGeometry({ type: 'Polygon', coordinates: [[[0, 30], [130, 30], [130, 60], [0, 60], [0, 30]]] }, camera);
  assert.ok(model.length > 0);
  const samples = [0, .2, .5, .8, 1].map(progress => morphPath(model, progress));
  for (const path of samples) { assert.doesNotMatch(path, /NaN|Infinity/); assert.ok(path.endsWith('Z')); }
  assert.equal(new Set(samples.map(path => (path.match(/L/g) || []).length)).size, 1);
  assert.deepEqual(morphGeometry(null, camera), []);
});
test('projection spring reacts on its first frame, reverses without resetting position and settles at either endpoint', () => {
  let state = { position: 0, velocity: 0 };
  state = projectionSpring(state.position, state.velocity, 1, 16);
  assert.ok(state.position > 0 && state.position < 1);
  for (let i = 0; i < 6; i++) state = projectionSpring(state.position, state.velocity, 1, 16);
  const before = state.position;
  state = projectionSpring(state.position, state.velocity, 0, 1);
  assert.ok(Math.abs(state.position - before) < .02, 'reversing must not jump to an endpoint');
  for (let i = 0; i < 60; i++) state = projectionSpring(state.position, state.velocity, 0, 16);
  assert.ok(Math.abs(state.position) < .00001);
  for (let i = 0; i < 60; i++) state = projectionSpring(state.position, state.velocity, 1, 16);
  assert.ok(Math.abs(state.position - 1) < .00001);
});
test('back-facing terrain is prepared before handoff and revealed progressively, never added on the last frame', () => {
  const geometry = { type: 'Polygon', coordinates: [[[140, -30], [150, -30], [150, -20], [140, -20], [140, -30]]] };
  assert.equal(morphGeometry(geometry, camera).length, 0);
  const back = flatBackPath(geometry, camera);
  assert.ok(back.startsWith('M') && back.endsWith('Z'));
  assert.doesNotMatch(back, /NaN|Infinity/);
  assert.equal(peripheralReveal(0), 0);
  assert.equal(peripheralReveal(.3), 0);
  assert.ok(peripheralReveal(.6) > 0 && peripheralReveal(.6) < 1);
  assert.equal(peripheralReveal(.9), 1);
});
