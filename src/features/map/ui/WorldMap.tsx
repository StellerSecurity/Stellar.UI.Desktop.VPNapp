import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { PendingText } from '../../../shared/ui/PendingText';
import { ConnectionCard } from '../../connection/ui/ConnectionCard';
import { Icon } from '../../../shared/ui/Icon';
import { countryCode, countryMapFeatures, geometryToPath, placement, routeCurve, type Coordinate, type WorldMap as WorldMapData } from '../domain/geometry';
import { MapViewport, reducedMotion } from '../application/MapViewport';
import { RouteTransition } from './RouteTransition';
import { mapStatus } from '../domain/MapStatus';
import { CountryFlag } from '../../../shared/ui/CountryFlag';
import { compactConnectionLayout } from '../../connection/domain/ConnectionLayout';
import { Globe } from './Globe';
import { useMapProjection } from './useMapProjection';
import { ProjectionMorph } from './ProjectionMorph';
import { SpaceBackground } from './SpaceBackground';

const labels = [
  { name: 'North America', lon: -105, lat: 45 }, { name: 'South America', lon: -60, lat: -22 },
  { name: 'Europe', lon: 16, lat: 53 }, { name: 'Africa', lon: 20, lat: 4 },
  { name: 'Asia', lon: 88, lat: 42 }, { name: 'Oceania', lon: 137, lat: -24 }
];
const BUTTON_ZOOM_FACTOR = 1.6;
export function WorldMap() {
  const t = useTranslation();
  const app = useApp();
  const root = useRef<HTMLElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const viewport = useRef<MapViewport | null>(null);
  const latest = useRef(app); latest.current = app;
  const hovered = useRef<string | null>(null);
  const dismissed = useRef(false);
  const [map, setMap] = useState<WorldMapData | null>(null);
  const countries = useMemo(() => map?.features.flatMap(countryMapFeatures).map(feature => ({ feature, path: geometryToPath(feature.geometry) })) ?? [], [map]);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('');
  const [globe, setGlobe] = useState(false);
  const projection = useMapProjection(globe);
  const globeCentre = useRef<Coordinate | undefined>(undefined);
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
    tip.textContent = server.city; tip.hidden = false;
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
    viewport.current = new MapViewport(root.current, positionTooltip, id => latest.current.activateMarker(id), () => compactConnectionLayout || latest.current.collapsed, (value, centre) => { if (value && centre) globeCentre.current = centre; setGlobe(value); });
    return () => { viewport.current?.destroy(); viewport.current = null; };
  }, []);
  useEffect(() => { if (map && app.selected) viewport.current?.focus(app.selected); }, [map]);
  useEffect(() => {
    dismissed.current = false;
    const previous = app.servers.find(server => server.id === previousId.current);
    previousId.current = app.selectedId;
    if (!projection.displayed && projection.phase === 'stable') {
      globeCentre.current = app.selected;
      if (app.selected) viewport.current?.rememberGlobeCentre(app.selected);
    }
    setRoute(previous && app.selected && previous.id !== app.selectedId && !reducedMotion() ? routeCurve(previous, app.selected) : '');
    if (app.selected) viewport.current?.focus(app.selected);
    const timer = setTimeout(() => setRoute(''), 1200);
    return () => clearTimeout(timer);
  }, [app.selectedId]);
  useEffect(positionTooltip, [app.view, app.pending, app.collapsed]);
  const { connected, securedServerId } = mapStatus(app.snapshot?.connection, app.pending);
  const connecting = app.pending && app.pendingAction === 'connect';
  const securedCountry = app.servers.find(server => server.id === securedServerId)?.countryCode;
  return <main ref={root} data-projection-target={globe ? 'globe' : 'flat'} className={`map-panel ${projection.displayed ? 'map-globe' : ''} ${connected ? 'connected' : ''} ${connecting ? 'connecting' : ''}`} data-projection-phase={projection.phase} id="map-panel" tabIndex={app.view === 'connection' && !projection.displayed ? 0 : -1} inert={app.view !== 'connection'} aria-hidden={app.view !== 'connection' || undefined} aria-label={t("Interactive world map. Drag or use arrow keys to move; pinch or double-click to zoom.")} onKeyDown={event => { if (event.key === 'Escape') { dismissed.current = true; positionTooltip(); } }}>
    <div className="map-glow" aria-hidden="true" />
    <SpaceBackground />
    <div className="map-art-frame" inert={projection.displayed || projection.phase !== 'stable'} aria-hidden={projection.displayed || undefined}><div className="map-art">
      <svg className="world-map" viewBox="0 0 1100 760" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g>{t(countries.map(({ feature, path }, index) => <path key={index} className={`world-country ${countryCode(feature) === app.selected?.countryCode ? 'active' : ''} ${countryCode(feature) === securedCountry ? 'secured' : ''}`} data-country-code={countryCode(feature)} d={path}><title>{t(feature.properties.ADMIN || feature.properties.NAME)}</title></path>))}</g></svg>
      <div id="map-labels" aria-hidden="true">{t(labels.map(label => <span key={label.name} className="map-label" style={placement(label)}>{t(label.name)}</span>))}</div>
      <div id="map-pins" role="group" aria-label={t("VPN locations")}>{t(app.servers.map(server => <button key={server.id} data-map={server.id} className={`map-pin ${server.id === app.selectedId ? 'selected' : ''} ${server.id === securedServerId ? 'secured' : ''}`} style={placement(server)} aria-label={`${t(`Choose ${server.city}, ${t(server.country)}`)}${server.id === securedServerId ? `, ${t('Connected')}` : server.id === app.selectedId ? `, ${t('Not connected')}` : ''}`} aria-pressed={server.id === app.selectedId}
        onClick={event => { if (event.detail === 0) app.activateMarker(server.id); }}
        onPointerEnter={() => { hovered.current = server.id; dismissed.current = false; positionTooltip(); }}
        onPointerLeave={() => { hovered.current = null; positionTooltip(); }}
        onFocus={() => { hovered.current = server.id; dismissed.current = false; positionTooltip(); }}
        onBlur={() => { hovered.current = null; positionTooltip(); }}><CountryFlag code={server.countryCode} className="map-pin-flag" /></button>))}</div>
      {t(route && <RouteTransition key={route} curve={route} />)}
    </div></div>
    {projection.displayed && map && <Globe map={map} servers={app.servers} selected={app.selected} securedId={securedServerId} initialCentre={globeCentre.current} interactive={projection.phase === 'stable'} onRotate={centre => { globeCentre.current = centre; viewport.current?.rememberGlobeCentre(centre); }} onSelect={id => app.activateMarker(id)} onZoom={() => viewport.current?.zoomBy(BUTTON_ZOOM_FACTOR)} />}
    {projection.phase !== 'stable' && map && <ProjectionMorph map={map} centre={globeCentre.current ?? app.selected ?? { lon: 12, lat: 25 }} fromGlobe={projection.fromGlobe} targetGlobe={globe} servers={app.servers} selectedId={app.selectedId} securedId={securedServerId} onComplete={projection.complete} />}
    <div ref={tooltip} id="map-tooltip" className="map-tooltip" role="tooltip" hidden />
    <div className="map-top"><div className="connection-statuses"><div className="connection-pill" role="status" aria-live="polite"><Icon name={connected ? 'shield' : 'globe'} />{t(app.pending ? <PendingText label={t(connecting ? 'Connecting' : 'Disconnecting')} /> : connected ? 'Protected' : 'Not protected')}</div>
      {t(connected && <div className="connection-features"><button className="connection-feature relay-feature" aria-label={t("About Stellar Relay")} onClick={() => app.setView('relay')}><Icon name="relay" /><span>{t("Stellar Relay")}</span></button></div>)}
      {app.snapshot?.settings.autoRotate && <button className="connection-feature relay-feature" onClick={() => app.setDialog('auto-rotate')} aria-label={t('Auto Rotate')}><Icon name="rotate" /><span>{t('Auto Rotate')}</span></button>}
    </div><div className="map-actions"><div className="map-zoom" role="group" aria-label={t("Map zoom")}><button id="zoom-out" aria-label={t("Zoom out")} onClick={() => viewport.current?.zoomBy(1 / BUTTON_ZOOM_FACTOR)}>−</button><button id="zoom-in" aria-label={t("Zoom in")} onClick={() => viewport.current?.zoomBy(BUTTON_ZOOM_FACTOR)}>+</button></div></div></div>
    {t(error && <div className="map-load-error" role="alert">{t(error)}</div>)}
    <ConnectionCard />
  </main>;
}
