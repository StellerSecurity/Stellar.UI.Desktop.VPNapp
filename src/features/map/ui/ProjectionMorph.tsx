import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { countryCode, countryMapFeatures, type Coordinate, type WorldMap } from '../domain/geometry';
import { globePoint } from '../domain/globe';
import { flatBackPath, morphGeometry, morphPath, morphPosition, morphVertex, peripheralReveal, projectionSpring, type MorphCamera } from '../domain/projectionMorph';
import { globeMarkers } from '../domain/globeMarkers';
import type { Server } from '../../locations/domain/Server';
import { CountryFlag } from '../../../shared/ui/CountryFlag';

export function ProjectionMorph({ map, centre, fromGlobe, targetGlobe, servers, selectedId, securedId, onComplete }: {
  map: WorldMap; centre: Coordinate; fromGlobe: boolean; targetGlobe: boolean; servers: Server[];
  selectedId: string; securedId: string | null; onComplete: (globe: boolean) => void;
}) {
  const measure = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), locations = useRef<HTMLDivElement>(null);
  const goal = useRef(targetGlobe); goal.current = targetGlobe;
  const done = useRef(onComplete); done.current = onComplete;
  const [model, setModel] = useState<ReturnType<typeof createModel> | null>(null);
  function createModel(camera: MorphCamera, width: number, height: number, targets: Element[]) {
    const securedCountry = servers.find(server => server.id === securedId)?.countryCode;
    const previousFlags = new Set([...measure.current!.parentElement!.querySelectorAll<HTMLElement>('[data-globe-location][data-marker-kind="flag"]')].map(pin => pin.dataset.globeLocation!));
    const markers = globeMarkers(servers, camera.centre, camera.sphere.radius, securedId, selectedId, previousFlags);
    const flagIds = new Set(markers.filter(marker => marker.flag).map(marker => marker.location.id));
    return { camera, width, height,
      countries: map.features.flatMap(countryMapFeatures).map((feature, index) => ({
        code: countryCode(feature), rings: morphGeometry(feature.geometry, camera), back: flatBackPath(feature.geometry, camera), secured: countryCode(feature) === securedCountry,
        targetFill: targets[index] ? getComputedStyle(targets[index]).fill : '#1456bd',
        targetOpacity: targets[index] ? getComputedStyle(targets[index]).fillOpacity : '1',
      })),
      pins: servers.map(server => {
        const flag = measure.current?.parentElement?.querySelector<HTMLElement>(`[data-map="${server.id}"] .map-pin-flag`);
        return { server, vertex: morphVertex(server, camera), front: globePoint(server, camera.centre).z >= .05, flag: flagIds.has(server.id), flagHeight: flag?.getBoundingClientRect().height || 12, flagWidth: flag?.getBoundingClientRect().width || 19 };
      }) };
  }
  useLayoutEffect(() => {
    const node = measure.current, root = node?.parentElement, flat = root?.querySelector<HTMLElement>('.map-art');
    if (!node || !root || !flat) return;
    const bounds = root.getBoundingClientRect(), plane = flat.getBoundingClientRect();
    const camera: MorphCamera = { centre, sphere: { x: node.offsetLeft, y: node.offsetTop + node.offsetHeight / 2, radius: node.offsetWidth * .48 },
      plane: { left: plane.left - bounds.left, top: plane.top - bounds.top, width: plane.width, height: plane.height } };
    setModel(createModel(camera, bounds.width, bounds.height, [...root.querySelectorAll('.world-country')]));
  }, []);
  useLayoutEffect(() => {
    if (!model || !svg.current) return;
    let frame = 0, last = performance.now(), position = fromGlobe ? 0 : 1, velocity = 0;
    const paths = [...svg.current.querySelectorAll<SVGPathElement>('[data-morph-country]')];
    const pins = [...locations.current!.querySelectorAll<HTMLElement>('[data-morph-pin]')];
    const ocean = svg.current.querySelector<SVGCircleElement>('[data-morph-ocean]')!;
    const shading = svg.current.querySelector<SVGCircleElement>('[data-morph-shading]')!;
    const gradient = svg.current.querySelector<SVGRadialGradientElement>('[data-morph-gradient]')!;
    const maxRadius = Math.hypot(model.width, model.height);
    const back = svg.current.querySelector<SVGGElement>('[data-morph-back]')!;
    const paint = (p: number) => {
      svg.current!.style.setProperty('--projection-progress', String(p));
      const reveal = peripheralReveal(p); back.setAttribute('opacity', String(reveal));
      model.countries.forEach((country, i) => paths[i].setAttribute('d', morphPath(country.rings, p)));
      model.pins.forEach((pin, i) => {
        const point = morphPosition(pin.vertex, pin.front ? p : 1); pins[i].style.left = `${point.x}px`; pins[i].style.top = `${point.y}px`;
        pins[i].style.setProperty('--marker-flag-opacity', String(pin.front ? pin.flag ? 1 : reveal : reveal));
        pins[i].style.setProperty('--marker-dot-opacity', String(pin.front && !pin.flag ? 1 - reveal : 0));
        const flag = pins[i].querySelector<HTMLElement>('.map-pin-flag')!;
        flag.style.height = `${12 + (pin.flagHeight - 12) * p}px`; flag.style.maxWidth = `${19 + (pin.flagWidth - 19) * p}px`;
      });
      const radius = model.camera.sphere.radius + (maxRadius - model.camera.sphere.radius) * p;
      ocean.setAttribute('r', String(radius)); gradient.setAttribute('r', String(radius * 1.6));
      shading.setAttribute('r', String(radius)); shading.setAttribute('opacity', String(1 - p));
    };
    paint(position);
    const tick = (now: number) => {
      const target = goal.current ? 0 : 1;
      const next = projectionSpring(position, velocity, target, now - last); last = now;
      position = Math.max(0, Math.min(1, next.position)); velocity = next.velocity; paint(position);
      if (Math.abs(position - target) < .001 && Math.abs(velocity) < .035) { paint(target); done.current(goal.current); }
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [model]);
  return <>
    <div ref={measure} className="globe-surface projection-measure" aria-hidden="true" />
    {model && <>
      <svg ref={svg} className="projection-morph" viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden="true">
        <defs><radialGradient id="projection-ocean" data-morph-gradient gradientUnits="userSpaceOnUse" cx={model.camera.sphere.x - model.camera.sphere.radius * .3} cy={model.camera.sphere.y - model.camera.sphere.radius * .5} r={model.camera.sphere.radius * 1.6}>
          <stop stopColor="#1457ad" /><stop offset=".75" stopColor="#0b3186" /><stop offset="1" stopColor="#061c56" />
        </radialGradient></defs>
        <circle data-morph-ocean cx={model.camera.sphere.x} cy={model.camera.sphere.y} r={model.camera.sphere.radius} fill="var(--map-background)" />
        <circle data-morph-shading cx={model.camera.sphere.x} cy={model.camera.sphere.y} r={model.camera.sphere.radius} fill="url(#projection-ocean)" />
        <g data-morph-back>{model.countries.map((country, index) => <path key={index} d={country.back} fillRule="evenodd" className={`projection-country ${country.secured ? 'secured' : ''}`} style={{ '--projection-target-fill': country.targetFill, '--projection-target-opacity': country.targetOpacity } as CSSProperties} />)}</g>
        {model.countries.map((country, index) => <path key={index} data-morph-country fillRule="evenodd" className={`projection-country ${country.secured ? 'secured' : ''}`}
          style={{ '--projection-target-fill': country.targetFill, '--projection-target-opacity': country.targetOpacity } as CSSProperties} />)}
      </svg>
      <div ref={locations} className="projection-morph-locations" aria-hidden="true">{model.pins.map(({ server }) => <span key={server.id} data-morph-pin className={`globe-pin ${server.id === securedId ? 'secured' : ''} ${server.id === selectedId ? 'selected' : ''}`}><CountryFlag code={server.countryCode} className="map-pin-flag" /><i className="globe-marker-dot" /></span>)}</div>
    </>}
  </>;
}
