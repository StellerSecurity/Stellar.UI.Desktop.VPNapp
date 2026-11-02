import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Coordinate, WorldMap } from '../domain/geometry';
import { countryCode, countryMapFeatures } from '../domain/geometry';
import { globeGlide, globePath, rotateGlobe } from '../domain/globe';
import type { Server } from '../../locations/domain/Server';
import { CountryFlag } from '../../../shared/ui/CountryFlag';
import { useTranslation } from '../../../shared/i18n/I18n';
import './globe.css';
import { globeMarkers } from '../domain/globeMarkers';

export function Globe({ map, servers, selected, securedId, initialCentre, interactive, onRotate, onSelect, onZoom }: {
  map: WorldMap; servers: Server[]; selected?: Server; securedId?: string | null;
  initialCentre?: Coordinate; interactive: boolean; onRotate: (centre: Coordinate) => void;
  onSelect: (id: string) => void; onZoom: () => void;
}) {
  const t = useTranslation();
  const [centre, setCentre] = useState<Coordinate>(() => initialCentre ?? ({ lon: selected?.lon ?? 12, lat: Math.min(55, selected?.lat ?? 25) }));
  const rotate = useRef(onRotate); rotate.current = onRotate;
  useEffect(() => { rotate.current(centre); }, [centre]);
  const drag = useRef<{ id: number; x: number; y: number; centre: Coordinate; lastX: number; lastY: number; time: number; vx: number; vy: number; moved: boolean } | null>(null);
  const momentum = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const [radius, setRadius] = useState(160);
  const previousFlags = useRef<ReadonlySet<string>>(new Set());
  const markers = useMemo(() => globeMarkers(servers, centre, radius, securedId, selected?.id, previousFlags.current), [servers, centre, radius, securedId, selected?.id]);
  useLayoutEffect(() => { previousFlags.current = new Set(markers.filter(marker => marker.flag).map(marker => marker.location.id)); }, [markers]);
  useLayoutEffect(() => {
    const node = surface.current; if (!node) return;
    const measure = () => setRadius(node.offsetWidth * .48);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const zoom = useRef(onZoom); zoom.current = onZoom;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const stop = () => { cancelAnimationFrame(momentum.current); momentum.current = 0; };
  useEffect(() => { if (!interactive) { stop(); drag.current = null; pointers.current.clear(); } }, [interactive]);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', stop);
    return () => { stop(); preference.removeEventListener('change', stop); };
  }, []);
  useEffect(() => {
    const node = surface.current; if (!node) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (event.deltaY < 0) zoom.current(); };
    const gesture = (event: Event) => { event.preventDefault(); if ((event as Event & { scale?: number }).scale! > 1.12) zoom.current(); };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('gesturestart', gesture, { passive: false });
    node.addEventListener('gesturechange', gesture, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); node.removeEventListener('gesturestart', gesture); node.removeEventListener('gesturechange', gesture); };
  }, []);
  const features = useMemo(() => map.features.flatMap(countryMapFeatures), [map]);
  const countries = useMemo(() => features.map(feature => ({ code: countryCode(feature), path: globePath(feature.geometry, centre) })), [features, centre]);
  const securedCountry = servers.find(server => server.id === securedId)?.countryCode;
  return <div ref={surface} className="globe-surface" role="group" tabIndex={0} inert={!interactive}
    aria-label={t('Interactive world map. Drag or use arrow keys to move; pinch or double-click to zoom.')}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      stop();
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]; pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
        drag.current = null; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return;
      }
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, centre, lastX: event.clientX, lastY: event.clientY, time: event.timeStamp, vx: 0, vy: 0, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    }}
    onPointerMove={event => {
      if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        if (pinch.current > 0 && Math.hypot(a.x - b.x, a.y - b.y) > pinch.current * 1.12) onZoom();
        return;
      }
      const d = drag.current; if (d?.id !== event.pointerId) return;
      const dt = Math.max(1, event.timeStamp - d.time);
      d.vx = d.vx * .6 + (event.clientX - d.lastX) / dt * .4;
      d.vy = d.vy * .6 + (event.clientY - d.lastY) / dt * .4;
      d.lastX = event.clientX; d.lastY = event.clientY; d.time = event.timeStamp;
      d.moved ||= Math.hypot(event.clientX - d.x, event.clientY - d.y) > 5;
      setCentre(rotateGlobe(d.centre, event.clientX - d.x, event.clientY - d.y));
    }}
    onPointerUp={event => {
      const d = drag.current; drag.current = null;
      pointers.current.delete(event.pointerId); pinch.current = 0;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!d?.moved || d.id !== event.pointerId || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const pause = Math.exp(-Math.max(0, event.timeStamp - d.time - 25) / 60);
      let vx = Math.max(-1.8, Math.min(1.8, d.vx)) * pause, vy = Math.max(-1.8, Math.min(1.8, d.vy)) * pause;
      let last = performance.now();
      const glide = (now: number) => {
        const dt = Math.min(32, now - last); last = now;
        const next = globeGlide(vx, vy, dt);
        setCentre(current => rotateGlobe(current, next.dx, next.dy));
        vx = next.vx; vy = next.vy;
        if (Math.hypot(vx, vy) > .008) momentum.current = requestAnimationFrame(glide);
        else momentum.current = 0;
      };
      momentum.current = requestAnimationFrame(glide);
    }}
    onPointerCancel={() => { drag.current = null; pointers.current.clear(); pinch.current = 0; stop(); }}
    onDoubleClick={event => { if (!(event.target as Element).closest('button')) { event.stopPropagation(); onZoom(); } }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      stop();
      const moves: Record<string, [number, number]> = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] };
      if (moves[event.key]) { event.preventDefault(); event.stopPropagation(); setCentre(current => rotateGlobe(current, ...moves[event.key])); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); onZoom(); }
      if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); setCentre({ lon: selected?.lon ?? 12, lat: Math.min(55, selected?.lat ?? 25) }); }
    }}>
    <svg viewBox="0 0 500 500" className="globe-world" aria-hidden="true">
      <defs><radialGradient id="stellar-globe-ocean" cx="35%" cy="25%" r="80%"><stop stopColor="#1457ad" /><stop offset=".75" stopColor="#0b3186" /><stop offset="1" stopColor="#061c56" /></radialGradient></defs>
      <circle cx="250" cy="250" r="240" fill="url(#stellar-globe-ocean)" className="globe-rim" />
      <g>{countries.map(({ code, path }, index) => <path key={index} d={path} className={`globe-country ${code === securedCountry ? 'secured' : ''}`} fillRule="evenodd" />)}</g>
    </svg>
    <div className="globe-locations" role="group" aria-label={t('VPN locations')}>{markers.map(({ location: server, point, flag }) => {
      return <button key={server.id} className={`globe-pin ${server.id === securedId ? 'secured' : ''} ${server.id === selected?.id ? 'selected' : ''}`}
        data-globe-location={server.id} data-marker-kind={flag ? 'flag' : 'dot'}
        style={{ left: `${50 + point.x * 48}%`, top: `${50 + point.y * 48}%` }}
        aria-label={`${t(`Choose ${server.city}, ${t(server.country)}`)}${server.id === securedId ? `, ${t('Connected')}` : ''}`}
        aria-pressed={server.id === selected?.id} onClick={() => onSelect(server.id)}>
        <CountryFlag code={server.countryCode} className="map-pin-flag" /><i className="globe-marker-dot" aria-hidden="true" /><span className="globe-pin-tooltip" aria-hidden="true">{server.city}</span>
      </button>;
    })}</div>
  </div>;
}
