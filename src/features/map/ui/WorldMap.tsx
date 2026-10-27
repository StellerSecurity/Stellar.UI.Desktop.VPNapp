import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { ConnectionCard } from '../../connection/ui/ConnectionCard';
import { Icon, type IconName } from '../../../shared/ui/Icon';
import { Loading } from '../../../shared/ui/Loading';
import { countryCode, geometryToPath, placement, routeCurve, type WorldMap as WorldMapData } from '../domain/geometry';
import { MapViewport, reducedMotion } from '../application/MapViewport';
import { RouteTransition } from './RouteTransition';

const labels = [
  { name: 'North America', lon: -105, lat: 45 }, { name: 'South America', lon: -60, lat: -22 },
  { name: 'Europe', lon: 16, lat: 53 }, { name: 'Africa', lon: 20, lat: 4 },
  { name: 'Asia', lon: 88, lat: 42 }, { name: 'Oceania', lon: 137, lat: -24 }
];
const BUTTON_ZOOM_FACTOR = 1.6;
export function WorldMap() {
  const app = useApp();
  const root = useRef<HTMLElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const viewport = useRef<MapViewport | null>(null);
  const latest = useRef(app); latest.current = app;
  const hovered = useRef<string | null>(null);
  const dismissed = useRef(false);
  const [map, setMap] = useState<WorldMapData | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('');
  const previousId = useRef(app.selectedId);
  function positionTooltip() {
    const panel = root.current, tip = tooltip.current; if (!panel || !tip) return;
    const state = latest.current;
    const id = hovered.current || (viewport.current && viewport.current.zoom >= 1.7 ? state.selectedId : null);
    const pin = [...panel.querySelectorAll<HTMLElement>('[data-map]')].find(element => element.dataset.map === id);
    const server = state.servers.find(item => item.id === id);
    if (!pin || !server || dismissed.current || state.view !== 'connection') { tip.hidden = true; return; }
    const bounds = panel.getBoundingClientRect(), anchor = pin.getBoundingClientRect();
    const x = anchor.left + anchor.width / 2 - bounds.left, y = anchor.top - bounds.top;
    if (x < 8 || x > bounds.width - 8 || y < 72 || y > bounds.height - 8) { tip.hidden = true; return; }
    tip.textContent = `${server.flag} ${server.city}`; tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.width - width - 8, x - width / 2));
    const above = y - height - 10 >= 72;
    tip.dataset.placement = above ? 'above' : 'below'; tip.style.left = `${left}px`;
    tip.style.top = `${above ? y - height - 10 : y + anchor.height + 10}px`;
    tip.style.setProperty('--anchor-x', `${Math.max(12, Math.min(width - 12, x - left))}px`);
  }
  useEffect(() => {
    const abort = new AbortController();
    app.loadWorldMap(abort.signal).then(setMap).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [app.loadWorldMap]);
  useEffect(() => {
    if (!root.current) return;
    viewport.current = new MapViewport(root.current, positionTooltip, id => latest.current.selectServer(id), () => latest.current.collapsed);
    return () => { viewport.current?.destroy(); viewport.current = null; };
  }, []);
  useEffect(() => { if (map && app.selected) viewport.current?.focus(app.selected); }, [map]);
  useEffect(() => {
    dismissed.current = false;
    const previous = app.servers.find(server => server.id === previousId.current);
    previousId.current = app.selectedId;
    setRoute(previous && app.selected && previous.id !== app.selectedId && !reducedMotion() ? routeCurve(previous, app.selected) : '');
    if (app.selected) viewport.current?.focus(app.selected);
    const timer = setTimeout(() => setRoute(''), 1200);
    return () => clearTimeout(timer);
  }, [app.selectedId]);
  useEffect(positionTooltip, [app.view, app.pending, app.collapsed]);
  const connected = app.snapshot?.connection.status === 'connected';
  const features: { label: string; icon: IconName; on: boolean }[] = [
    { label: 'Stellar Relay', icon: 'relay', on: true },
    { label: 'Auto Rotate', icon: 'rotate', on: !!app.snapshot?.settings.autoRotate },
    { label: 'Kill switch', icon: 'shield', on: !!app.snapshot?.settings.killSwitch }
  ];
  return <main ref={root} className={`map-panel ${connected ? 'connected' : ''} ${app.pending ? 'connecting' : ''}`} id="map-panel" tabIndex={app.view === 'connection' ? 0 : -1} inert={app.view !== 'connection'} aria-hidden={app.view !== 'connection' || undefined} aria-label="Interactive world map. Drag or use arrow keys to move; pinch or double-click to zoom." onKeyDown={event => { if (event.key === 'Escape') { dismissed.current = true; positionTooltip(); } }}>
    <div className="map-glow" aria-hidden="true" />
    <div className="map-art-frame"><div className="map-art">
      <svg className="world-map" viewBox="0 0 1100 760" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g>{map?.features.map((feature, index) => <path key={index} className={`world-country ${countryCode(feature) === app.selected?.countryCode ? 'active' : ''}`} data-country-code={countryCode(feature)} d={geometryToPath(feature.geometry)}><title>{feature.properties.ADMIN || feature.properties.NAME}</title></path>)}</g></svg>
      <div id="map-labels" aria-hidden="true">{labels.map(label => <span key={label.name} className="map-label" style={placement(label)}>{label.name}</span>)}</div>
      <div id="map-pins" role="group" aria-label="VPN locations">{app.servers.map(server => <button key={server.id} data-map={server.id} className={`map-pin ${server.id === app.selectedId ? 'selected' : ''}`} style={placement(server)} aria-label={`Choose ${server.city}, ${server.country}`} aria-pressed={server.id === app.selectedId}
        onClick={event => { if (event.detail === 0) app.selectServer(server.id); }}
        onPointerEnter={() => { hovered.current = server.id; dismissed.current = false; positionTooltip(); }}
        onPointerLeave={() => { hovered.current = null; positionTooltip(); }}
        onFocus={() => { hovered.current = server.id; dismissed.current = false; positionTooltip(); }}
        onBlur={() => { hovered.current = null; positionTooltip(); }} />)}</div>
      {route && <RouteTransition key={route} curve={route} />}
    </div></div>
    <div ref={tooltip} id="map-tooltip" className="map-tooltip" role="tooltip" hidden />
    <div className="map-top"><div className="connection-statuses"><div className="connection-pill" role="status" aria-live="polite">{app.pending ? <Loading label="Loading connection" /> : <><Icon name={connected ? 'shield' : 'globe'} />{connected ? 'Protected' : 'Not protected'}</>}</div>
      <div className="connection-features" role="list" aria-label="Privacy features">{features.filter(feature => feature.on).map(feature => <span key={feature.label} className="connection-feature is-on" role="listitem" aria-label={`${feature.label}: on`}><Icon name={feature.icon} /><span>{feature.label}</span><i aria-hidden="true" /></span>)}</div>
    </div></div>
    {error && <div className="map-load-error" role="alert">{error}</div>}
    <ConnectionCard />
    <div className="map-bottom"><div className="map-actions"><button id="reset-map" hidden onClick={() => viewport.current?.reset()}>Reset map</button><div className="map-zoom" role="group" aria-label="Map zoom"><button id="zoom-out" aria-label="Zoom out" onClick={() => viewport.current?.zoomBy(1 / BUTTON_ZOOM_FACTOR)}>−</button><button id="zoom-in" aria-label="Zoom in" onClick={() => viewport.current?.zoomBy(BUTTON_ZOOM_FACTOR)}>+</button></div></div></div>
  </main>;
}
