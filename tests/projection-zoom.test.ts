import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionZoom } from '../src/features/map/domain/ProjectionZoom.ts';

test('globe handoff opens a broad flat overview, not the previous deep zoom', () => {
  const zoom = new ProjectionZoom();
  assert.ok(zoom.overviewZoom > .9 && zoom.overviewZoom < 1.22);
  assert.equal(zoom.consume(0, false), false);
});

test('a continuous gesture is consumed through the morph and its momentum tail, then a fresh gesture can zoom', () => {
  const zoom = new ProjectionZoom(); zoom.begin(0);
  for (let now = 16; now < 1600; now += 16) {
    assert.equal(zoom.consume(now, now < 600), true);
  }
  assert.equal(zoom.consume(1800, false), false);
  assert.equal(zoom.consume(1816, false), false);
  zoom.begin(2000);
  assert.equal(zoom.consume(2400, true), true);
  assert.equal(zoom.consume(2500, false), true);
  assert.equal(zoom.consume(2700, false), false);
});
