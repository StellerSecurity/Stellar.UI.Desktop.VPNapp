/** Split the quadratic itself: dash lengths with non-scaling strokes break under map zoom. */
export function routeFrame(curve: string, progress: number) {
  const values = curve.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number);
  if (!values || values.length !== 6 || !values.every(Number.isFinite)) return null;
  const [ax, ay, cx, cy, bx, by] = values;
  const t = Math.max(0, Math.min(1, progress));
  const control = { x: ax + (cx - ax) * t, y: ay + (cy - ay) * t };
  const next = { x: cx + (bx - cx) * t, y: cy + (by - cy) * t };
  const point = { x: control.x + (next.x - control.x) * t, y: control.y + (next.y - control.y) * t };
  const dx = (1 - t) * (cx - ax) + t * (bx - cx);
  const dy = (1 - t) * (cy - ay) + t * (by - cy);
  return { path: `M${ax} ${ay} Q${control.x} ${control.y} ${point.x} ${point.y}`, point, angle: Math.atan2(dy, dx) * 180 / Math.PI };
}
