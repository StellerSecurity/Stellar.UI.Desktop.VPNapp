import { useEffect, useRef } from 'react';
import { reducedMotion } from '../application/MapViewport';

/** Visual feedback only: never delays server selection or connection commands. */
export function RouteTransition({ curve }: { curve: string }) {
  const layer = useRef<SVGSVGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const glow = useRef<SVGPathElement>(null);
  const arrow = useRef<SVGGElement>(null);
  useEffect(() => {
    const line = path.current, halo = glow.current, head = arrow.current, surface = layer.current;
    if (!line || !halo || !head || !surface || reducedMotion()) return;
    let frame = 0, fade: ReturnType<typeof setTimeout>;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const length = line.getTotalLength();
    for (const stroke of [line, halo]) {
      stroke.style.strokeDasharray = `${length}`;
      stroke.style.strokeDashoffset = `${length}`;
    }
    const stop = () => {
      cancelAnimationFrame(frame); clearTimeout(fade);
      surface.classList.remove('active'); head.setAttribute('visibility', 'hidden');
    };
    const started = performance.now();
    const draw = (now: number) => {
      const progress = Math.min(1, (now - started) / 720);
      const distance = length * (1 - (1 - progress) ** 3);
      const point = line.getPointAtLength(distance);
      // A backward sample at arrival avoids a zero-length tangent.
      const before = line.getPointAtLength(Math.max(0, distance - 1));
      const after = line.getPointAtLength(Math.min(length, distance + 1));
      const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
      const matrix = line.getScreenCTM();
      const scaleX = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
      const scaleY = matrix ? Math.hypot(matrix.c, matrix.d) : 1;
      for (const stroke of [line, halo]) stroke.style.strokeDashoffset = `${length - distance}`;
      head.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle}) scale(${1 / (scaleX || 1)} ${1 / (scaleY || 1)})`);
      head.setAttribute('visibility', 'visible'); surface.classList.add('active');
      if (progress < 1) frame = requestAnimationFrame(draw);
      else {
        surface.classList.add('arrived'); head.classList.add('arrived');
        fade = setTimeout(stop, 240);
      }
    };
    frame = requestAnimationFrame(draw);
    motion.addEventListener('change', stop);
    return () => { stop(); motion.removeEventListener('change', stop); };
  }, [curve]);
  return <>
    <svg ref={layer} className="route-layer" viewBox="0 0 1100 760" preserveAspectRatio="none" aria-hidden="true">
      <path ref={glow} className="route-glow" d={curve} />
      <path ref={path} className="route-path" d={curve} />
    </svg>
    <svg className="route-arrow-layer" viewBox="0 0 1100 760" preserveAspectRatio="none" aria-hidden="true">
      <g ref={arrow} className="route-arrow" visibility="hidden"><circle r="15" /><path d="M-5 -7 8 0-5 7-1 0Z" /></g>
    </svg>
  </>;
}
