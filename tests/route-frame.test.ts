import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFrame } from '../src/features/map/domain/RouteFrame.ts';

test('route grows as one continuous curve and its endpoint always matches the arrow', () => {
  for (let step = 0; step <= 100; step++) {
    const t = step / 100;
    const frame = routeFrame('M0 0 Q50 100 100 0', t)!;
    assert.equal(frame.point.x, 100 * t);
    assert.ok(Math.abs(frame.point.y - 200 * t * (1 - t)) < 1e-10);
    assert.ok(frame.path.endsWith(`${frame.point.x} ${frame.point.y}`));
    assert.ok(Number.isFinite(frame.angle));
  }
});
test('route clamps progress, handles stationary routes and rejects malformed geometry', () => {
  assert.deepEqual(routeFrame('M0 0 Q50 100 100 0', -1), routeFrame('M0 0 Q50 100 100 0', 0));
  assert.deepEqual(routeFrame('M0 0 Q50 100 100 0', 2), routeFrame('M0 0 Q50 100 100 0', 1));
  assert.equal(routeFrame('M1 1 Q1 1 1 1', .5)?.angle, 0);
  assert.equal(routeFrame('invalid', .5), null);
});
