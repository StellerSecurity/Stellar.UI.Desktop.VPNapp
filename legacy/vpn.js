'use strict';

const paths = {
  shield: '<path d="m12 3 8 4v6c0 5-8 8-8 8s-8-3-8-8V7l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  check: '<path d="m7 12 3 3 7-7"/>',
  computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  power: '<path d="M12 3v9m-6.4-6.4a9 9 0 1 0 12.8 0"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  panelHide: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16"/><path d="m14 9-3 3 3 3"/>',
  panelShow: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16"/><path d="m11 9 3 3-3 3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z" transform="translate(2.5 0) scale(.8)"/>',
  relay: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.4 10.9 7.2-3.8M8.4 13.1l7.2 3.8"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4.8 21a7.2 7.2 0 0 1 14.4 0"/>',
  rotate: '<path d="M20 7v5h-5"/><path d="M18.2 16a8 8 0 1 1 .5-7.5L20 12"/>',
  chevron: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2"/>',
  logout: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4m4-4H8"/>',
  building: '<path d="M4 21h16M6 21V8l6-5 6 5v13M9 11h2m2 0h2m-6 4h2m2 0h2"/>',
  noLogs: '<path d="M5 4h14v16H5zM8 8h8m-8 4h5"/><path d="m15 14 5 5m0-5-5 5"/>',
  sparkles: '<path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM5 14l.7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7L5 14Z"/>',
  wifi: '<path d="M3.5 9a13 13 0 0 1 17 0M6.5 12.5a8.5 8.5 0 0 1 11 0M9.5 16a4 4 0 0 1 5 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
  plane: '<path d="m3 11 18-7-7 17-3-7-8-3Z"/><path d="m11 14 4-4"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3V9Z"/>',
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>'
};

const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const $ = id => document.getElementById(id);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let servers = [
  { id: 'cz-1', country: 'Czechia', countryCode: 'CZ', city: 'Prague', flag: '🇨🇿', lon: 14.4378, lat: 50.0755, favorite: true }
];

let selected = 'cz-1';
let mode = 'connected';
let favorites = false;
let started = Date.now();
let connectionTimer;
let toastTimer;
let mapPan = { x: 0, y: 0 };
let mapDrag = null;
let mapMomentumFrame = 0;
let mapViewFrame = 0;
let trackpadTimer;
let locationsCollapsed = false;
let suppressMapClickUntil = 0;
const defaultMapZoom = 1.22;
let mapZoom = defaultMapZoom;
let routeFrame;
let routeFadeTimer;
let routeGeneration = 0;
let tooltipTarget = null;
let tooltipDismissed = false;
let tooltipFrame = 0;

function scheduleMapTooltip() {
  if (tooltipFrame) return;
  tooltipFrame = requestAnimationFrame(() => {
    tooltipFrame = 0;
    positionMapTooltip();
  });
}

function positionMapTooltip() {
  const tooltip = $('map-tooltip');
  const activePin = document.activeElement?.closest('[data-map]');
  const id = tooltipTarget || activePin?.dataset.map || (mapZoom >= 1.7 ? selected : null);
  const pin = [...$('map-pins').children].find(element => element.dataset.map === id);
  const server = servers.find(item => item.id === id);
  $('map-pins').querySelectorAll('[aria-describedby]').forEach(element => element.removeAttribute('aria-describedby'));
  if (!pin || !server || tooltipDismissed || !$('preferences').hidden) {
    tooltip.hidden = true;
    return;
  }
  const panel = $('map-panel').getBoundingClientRect();
  const anchor = pin.getBoundingClientRect();
  const x = anchor.left + anchor.width / 2 - panel.left;
  const y = anchor.top - panel.top;
  const minTop = Math.max(8, document.querySelector('.topbar').getBoundingClientRect().bottom - panel.top + 8);
  if (x < 8 || x > panel.width - 8 || y + anchor.height < minTop || y > panel.height - 8) {
    tooltip.hidden = true;
    return;
  }
  tooltip.textContent = `${server.flag} ${server.city}`;
  tooltip.hidden = false;
  pin.setAttribute('aria-describedby', 'map-tooltip');
  const { width, height } = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(panel.width - width - 8, x - width / 2));
  const above = y - height - 10 >= minTop;
  tooltip.dataset.placement = above ? 'above' : 'below';
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(minTop, Math.min(panel.height - height - 8, above ? y - height - 10 : y + anchor.height + 10))}px`;
  tooltip.style.setProperty('--anchor-x', `${Math.max(12, Math.min(width - 12, x - left))}px`);
}

function renderMapPins() {
  const existing = new Map([...$('map-pins').children].map(pin => [pin.dataset.map, pin]));
  const ids = new Set(servers.map(server => server.id));
  existing.forEach((pin, id) => { if (!ids.has(id)) pin.remove(); });
  servers.forEach(server => {
    let pin = existing.get(server.id);
    if (!pin) {
      pin = document.createElement('button');
      pin.className = 'map-pin';
      pin.dataset.map = server.id;
      pin.style.cssText = placement(server.lon, server.lat);
      pin.setAttribute('aria-label', `Choose ${server.city}, ${server.country}`);
      $('map-pins').append(pin);
    }
    pin.classList.toggle('selected', server.id === selected);
    pin.setAttribute('aria-pressed', String(server.id === selected));
  });
  scheduleMapTooltip();
}

function placement(lon, lat) {
  const point = mapPoint({ lon, lat });
  return `left:${(point.x / 1100 * 100).toFixed(2)}%;top:${(point.y / 760 * 100).toFixed(2)}%`;
}

function flagForCountry(code) {
  return [...code].map(character => String.fromCodePoint(127397 + character.charCodeAt(0))).join('');
}

async function loadServerData() {
  try {
    const response = await fetch('assets/servers.json');
    if (!response.ok) throw new Error(`Server data returned ${response.status}`);
    const data = await response.json();
    const regionNames = typeof Intl.DisplayNames === 'function'
      ? new Intl.DisplayNames(['en'], { type: 'region' })
      : null;
    const favoritesByDefault = new Set(['CZ', 'DK', 'CH']);

    const normalized = data.filter(item =>
      item && item.id && item.name && /^[A-Z]{2}$/.test(item.country)
      && Number.isFinite(item.lat) && Number.isFinite(item.lon)
    ).map(item => {
      const code = item.country.toUpperCase();
      const [sourceCountry, sourceCity] = item.name.split(/\s+[–-]\s+/, 2);
      return {
        id: item.id,
        country: regionNames?.of(code) || sourceCountry,
        countryCode: code,
        city: sourceCity || sourceCountry,
        flag: flagForCountry(code),
        lon: item.lon,
        lat: item.lat,
        favorite: favoritesByDefault.has(code)
      };
    });

    if (!normalized.length) throw new Error('Server data did not contain any valid locations');
    servers = normalized;
    selected = servers.find(server => server.id === 'cz-1')?.id || servers[0].id;
  } catch (error) {
    console.error('Unable to load the server catalog.', error);
  }
}

function mapPoint(server) {
  return {
    x: (server.lon + 180) / 360 * 1100,
    y: 85 + (90 - server.lat) / 180 * 590
  };
}

function coordinatesToPath(coordinates) {
  return coordinates.map((ring, ringIndex) => ring.map(([lon, lat], pointIndex) => {
    const point = mapPoint({ lon, lat });
    return `${pointIndex ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(' ') + (ringIndex >= 0 ? ' Z' : '')).join(' ');
}

function geometryToPath(geometry) {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return coordinatesToPath(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(coordinatesToPath).join(' ');
  return '';
}

async function renderWorldMap() {
  try {
    const response = await fetch('assets/world-countries.geojson');
    if (!response.ok) throw new Error(`Map data returned ${response.status}`);
    const mapData = await response.json();
    $('world-countries').innerHTML = mapData.features.map(feature => {
      const isoCode = feature.properties.ISO_A2;
      const code = isoCode && isoCode !== '-99'
        ? isoCode
        : feature.properties.POSTAL || feature.properties.ADM0_A3 || '';
      const name = feature.properties.ADMIN || feature.properties.NAME || '';
      return `<path class="world-country" data-country-code="${esc(code)}" d="${geometryToPath(feature.geometry)}"><title>${esc(name)}</title></path>`;
    }).join('');
    updateSelectedCountry();
    requestAnimationFrame(() => focusServerOnMap(servers.find(server => server.id === selected)));
  } catch (error) {
    console.error('Unable to load the world map.', error);
  }
}

function updateSelectedCountry() {
  document.querySelectorAll('.world-country.active').forEach(country => country.classList.remove('active'));
  const code = servers.find(server => server.id === selected)?.countryCode;
  if (!code) return;
  document.querySelector(`.world-country[data-country-code="${code}"]`)?.classList.add('active');
}

function routeCurve(from, to) {
  const start = mapPoint(from);
  const end = mapPoint(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.min(95, Math.max(42, distance * 0.24));
  const controlX = (start.x + end.x) / 2 - dy / distance * bend;
  const controlY = (start.y + end.y) / 2 + dx / distance * bend;
  return `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`;
}

function clearRoute() {
  cancelAnimationFrame(routeFrame);
  clearTimeout(routeFadeTimer);
  routeGeneration += 1;
  $('route-layer').classList.remove('active', 'arrived');
  $('route-arrow').setAttribute('hidden', '');
}

function animateRoute(from, to, onArrive) {
  clearRoute();
  if (reducedMotion() || from.id === to.id) {
    onArrive();
    return;
  }

  const generation = routeGeneration;
  const layer = $('route-layer');
  const path = $('route-path');
  const glow = $('route-glow');
  const arrow = $('route-arrow');
  const curve = routeCurve(from, to);
  path.setAttribute('d', curve);
  glow.setAttribute('d', curve);
  const length = path.getTotalLength();

  for (const line of [path, glow]) {
    line.style.strokeDasharray = `${length}`;
    line.style.strokeDashoffset = `${length}`;
  }
  arrow.removeAttribute('hidden');
  layer.classList.remove('arrived');
  layer.classList.add('active');

  const startedAt = performance.now();
  const duration = 720;
  const draw = now => {
    if (generation !== routeGeneration) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const position = length * eased;
    const point = path.getPointAtLength(position);
    const nextPoint = path.getPointAtLength(Math.min(length, position + 1));
    const angle = Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x) * 180 / Math.PI;

    path.style.strokeDashoffset = `${length - position}`;
    glow.style.strokeDashoffset = `${length - position}`;
    arrow.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle}) scale(${(1 / mapZoom).toFixed(3)})`);

    if (progress < 1) {
      routeFrame = requestAnimationFrame(draw);
      return;
    }

    onArrive();
    layer.classList.add('arrived');
    routeFadeTimer = setTimeout(() => {
      if (generation !== routeGeneration) return;
      layer.classList.remove('active', 'arrived');
      arrow.setAttribute('hidden', '');
    }, 240);
  };

  routeFrame = requestAnimationFrame(draw);
}

function animateView(element) {
  if (reducedMotion()) return;
  element.classList.remove('view-enter');
  void element.offsetWidth;
  element.classList.add('view-enter');
}

function mapPanLimits(zoom = mapZoom) {
  const panel = $('map-panel');
  const frame = document.querySelector('.map-art-frame');
  const panelRect = panel.getBoundingClientRect();
  const locationsRect = $('locations-panel').getBoundingClientRect();
  const locationsOverlap = locationsCollapsed ||
    locationsRect.bottom <= panelRect.top ||
    locationsRect.top >= panelRect.bottom
    ? 0
    : Math.max(0, Math.min(panelRect.right, locationsRect.right) - Math.max(panelRect.left, locationsRect.left));
  const visibleMapWidth = Math.max(240, panel.clientWidth - locationsOverlap);
  const scaledMapWidth = frame.offsetWidth * zoom;
  const horizontalOverflow = Math.max(0, (scaledMapWidth - visibleMapWidth) / 2);
  const panelClearance = locationsOverlap * 0.5;
  return {
    x: Math.max(180, horizontalOverflow + panelClearance),
    y: Math.max(70, (frame.offsetHeight * zoom - panel.clientHeight) / 2)
  };
}

function clampMapPan(x, y, zoom = mapZoom) {
  const limits = mapPanLimits(zoom);
  return {
    x: Math.max(-limits.x, Math.min(limits.x, x)),
    y: Math.max(-limits.y, Math.min(limits.y, y))
  };
}

function stopMapViewAnimation() {
  if (mapViewFrame) cancelAnimationFrame(mapViewFrame);
  mapViewFrame = 0;
  $('map-panel').classList.remove('is-zooming');
}

function animateMapView(x, y, zoom, duration = 440) {
  stopMapViewAnimation();
  const targetZoom = Math.max(0.85, Math.min(8, zoom));
  const targetPan = clampMapPan(x, y, targetZoom);

  if (reducedMotion() || duration <= 0) {
    mapZoom = targetZoom;
    setMapPan(targetPan.x, targetPan.y);
    return;
  }

  const startZoom = mapZoom;
  const startPan = { ...mapPan };
  const startedAt = performance.now();
  $('map-panel').classList.add('is-zooming');

  const step = now => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    mapZoom = startZoom + (targetZoom - startZoom) * eased;
    setMapPan(
      startPan.x + (targetPan.x - startPan.x) * eased,
      startPan.y + (targetPan.y - startPan.y) * eased
    );

    if (progress < 1) {
      mapViewFrame = requestAnimationFrame(step);
      return;
    }

    mapViewFrame = 0;
    $('map-panel').classList.remove('is-zooming');
  };

  mapViewFrame = requestAnimationFrame(step);
}

function stopMapMomentum() {
  if (mapMomentumFrame) cancelAnimationFrame(mapMomentumFrame);
  mapMomentumFrame = 0;
  $('map-panel').classList.remove('is-inertial');
}

function startMapMomentum(velocityX, velocityY) {
  stopMapMomentum();
  if (reducedMotion() || Math.hypot(velocityX, velocityY) < 0.04) return;

  const panel = $('map-panel');
  let previousTime = performance.now();
  panel.classList.add('is-inertial');

  const glide = currentTime => {
    const elapsed = Math.min(32, currentTime - previousTime);
    previousTime = currentTime;
    const intendedX = mapPan.x + velocityX * elapsed;
    const intendedY = mapPan.y + velocityY * elapsed;
    const previousX = mapPan.x;
    const previousY = mapPan.y;

    setMapPan(intendedX, intendedY);
    if (Math.abs(mapPan.x - intendedX) > 0.5 && Math.abs(mapPan.x - previousX) < 0.5) velocityX = 0;
    if (Math.abs(mapPan.y - intendedY) > 0.5 && Math.abs(mapPan.y - previousY) < 0.5) velocityY = 0;

    const friction = Math.pow(0.9, elapsed / 16.67);
    velocityX *= friction;
    velocityY *= friction;

    if (Math.hypot(velocityX, velocityY) < 0.018) {
      stopMapMomentum();
      return;
    }
    mapMomentumFrame = requestAnimationFrame(glide);
  };

  mapMomentumFrame = requestAnimationFrame(glide);
}

function setMapPan(x, y) {
  mapPan = clampMapPan(x, y);
  const frame = document.querySelector('.map-art-frame');
  const art = document.querySelector('.map-art');
  art.style.width = `${frame.offsetWidth * mapZoom}px`;
  art.style.height = `${frame.offsetHeight * mapZoom}px`;
  art.style.setProperty('--map-pan-x', `${mapPan.x}px`);
  art.style.setProperty('--map-pan-y', `${mapPan.y}px`);
  art.style.setProperty('--map-zoom', mapZoom.toFixed(2));
  $('map-panel').classList.toggle('map-overview', mapZoom < 1.7);
  $('reset-map').hidden = Math.abs(mapPan.x) < 1 && Math.abs(mapPan.y) < 1 && Math.abs(mapZoom - defaultMapZoom) < 0.01;
  scheduleMapTooltip();
}

function resetMap() {
  stopMapMomentum();
  animateMapView(0, 0, defaultMapZoom);
}

function focusServerOnMap(server) {
  if (!server) return;
  stopMapMomentum();
  const panel = $('map-panel');
  const frame = document.querySelector('.map-art-frame');
  const point = mapPoint(server);
  const targetZoom = Math.max(mapZoom, 2.1);
  const pointOffsetX = (point.x / 1100 - 0.5) * frame.offsetWidth * targetZoom;
  const pointOffsetY = (point.y / 760 - 0.5) * frame.offsetHeight * targetZoom;
  const targetX = panel.clientWidth * (locationsCollapsed ? 0.5 : 0.66);
  const targetY = panel.clientHeight * 0.4;
  animateMapView(
    targetX - panel.clientWidth / 2 - pointOffsetX,
    targetY - panel.clientHeight / 2 - pointOffsetY,
    targetZoom
  );
}

function zoomMapAt(clientX, clientY, zoom, animated = false) {
  stopMapMomentum();
  stopMapViewAnimation();
  const panel = $('map-panel');
  const rect = panel.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const mapX = (localX - panel.clientWidth / 2 - mapPan.x) / mapZoom;
  const mapY = (localY - panel.clientHeight / 2 - mapPan.y) / mapZoom;
  const targetZoom = Math.max(0.85, Math.min(8, zoom));
  const targetX = localX - panel.clientWidth / 2 - mapX * targetZoom;
  const targetY = localY - panel.clientHeight / 2 - mapY * targetZoom;
  if (animated) animateMapView(targetX, targetY, targetZoom);
  else {
    mapZoom = targetZoom;
    setMapPan(targetX, targetY);
  }
}

function zoomMapFromCenter(zoom, animated = false) {
  const panel = $('map-panel');
  const rect = panel.getBoundingClientRect();
  const centerX = rect.left + panel.clientWidth * (locationsCollapsed ? 0.5 : 0.66);
  const centerY = rect.top + panel.clientHeight * 0.4;
  zoomMapAt(centerX, centerY, zoom, animated);
}

function setLocationsCollapsed(collapsed) {
  locationsCollapsed = collapsed;
  $('workspace').classList.toggle('locations-collapsed', collapsed);
  $('locations-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('locations-toggle').setAttribute('aria-label', collapsed ? 'Show locations' : 'Hide locations');
  $('locations-toggle').innerHTML = icon(collapsed ? 'panelShow' : 'panelHide');
}

function renderServers() {
  const focus = document.activeElement;
  const focusKey = focus?.dataset.select ? 'select' : focus?.dataset.star ? 'star' : null;
  const focusId = focusKey && focus.dataset[focusKey];
  const query = $('search').value.trim().toLocaleLowerCase('en');
  const list = servers
    .filter(server => (!favorites || server.favorite) && (!query || `${server.country} ${server.city}`.toLocaleLowerCase('en').includes(query)))
    .sort((a, b) => a.country.localeCompare(b.country, 'en') || a.city.localeCompare(b.city, 'en'));

  const selectedStatus = mode === 'connecting' ? '' : mode === 'connected' ? 'Connected' : 'Selected';

  $('server-list').innerHTML = list.map(server => `
    <div class="server-row ${server.id === selected ? `selected ${mode}` : ''}" role="listitem">
      <button class="server-select" data-select="${server.id}" aria-current="${server.id === selected ? 'true' : 'false'}" aria-label="Choose ${esc(server.country)}, ${esc(server.city)}">
        <span class="flag" aria-hidden="true">${server.flag}</span>
        <span class="server-copy"><strong class="server-name">${esc(server.country)}</strong><span class="server-city"> · ${esc(server.city)}</span></span>
        <span class="selected-check" aria-hidden="true"><span>${server.id === selected ? selectedStatus : ''}</span>${icon('check')}</span>
      </button>
      <button class="server-star ${server.favorite ? 'active' : ''}" data-star="${server.id}" aria-label="${server.favorite ? 'Remove' : 'Add'} ${esc(server.country)} ${server.favorite ? 'from' : 'to'} favorites" aria-pressed="${server.favorite}">${icon('star')}</button>
    </div>
  `).join('');

  $('location-count').textContent = list.length;
  $('server-empty').hidden = list.length > 0;
  $('server-list').classList.toggle('is-empty', list.length === 0);
  $('server-empty').textContent = favorites && !query ? 'No favorites yet. Add a location with the star.' : 'No locations match your search.';
  if (focusKey) [...$('server-list').querySelectorAll(`[data-${focusKey}]`)]
    .find(button => button.dataset[focusKey] === focusId)?.focus({ preventScroll: true });
}

function updateTimer() {
  if (mode !== 'connected') {
    $('session-time').textContent = '00:00:00';
    return;
  }
  const seconds = Math.floor((Date.now() - started) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  $('session-time').textContent = [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
}

function updateSpeed() {
  if (!$('traffic-speed')) return;
  if (mode !== 'connected') {
    $('traffic-speed').textContent = '—';
    return;
  }
  const phase = Date.now() / 1900;
  const down = 17.2 + Math.sin(phase) * 2.4;
  const up = 3.1 + Math.cos(phase * 0.8) * 0.7;
  $('traffic-speed').textContent = `↓${down.toFixed(1)}  ↑${up.toFixed(1)}`;
}

function renderPrivacyFeatures() {
  const settingIsOn = name => document.querySelector(`[data-setting="${name}"]`)?.getAttribute('aria-checked') === 'true';
  const features = [
    { label: 'Stellar Relay', iconName: 'relay', enabled: true },
    { label: 'Auto Rotate', iconName: 'rotate', enabled: settingIsOn('auto-rotate') },
    { label: 'Kill switch', iconName: 'shield', enabled: settingIsOn('kill-switch') }
  ];

  $('connection-features').innerHTML = features.filter(feature => feature.enabled).map(feature => `
    <span class="connection-feature is-on" role="listitem" aria-label="${feature.label}: on" title="${feature.label} · On">
      ${icon(feature.iconName)}<span>${feature.label}</span><i aria-hidden="true"></i>
    </span>
  `).join('');
}

function render() {
  const server = servers.find(item => item.id === selected);
  const connected = mode === 'connected';
  const connecting = mode === 'connecting';

  $('map-panel').classList.toggle('connected', connected);
  $('map-panel').classList.toggle('connecting', connecting);
  $('map-panel').classList.toggle('map-overview', mapZoom < 1.7);
  const loading = '<span class="status-loader" aria-hidden="true"></span><span class="sr-only">Loading connection</span>';
  $('connection-pill').innerHTML = connecting ? loading : icon(connected ? 'shield' : 'globe') + (connected ? 'Protected' : 'Not protected');
  renderPrivacyFeatures();
  $('status-symbol').innerHTML = icon(connected ? 'shield' : connecting ? 'globe' : 'power');
  $('status-title').innerHTML = connecting ? loading : connected ? 'Connected' : 'Disconnected';
  document.querySelector('.connection-card').setAttribute('aria-busy', String(connecting));
  $('selected-flag').textContent = server.flag;
  $('selected-country').textContent = server.country;
  $('selected-city').textContent = `${server.city} · ${server.id}`;
  $('connect-button').innerHTML = connecting ? loading : icon('power') + (connected ? 'Disconnect' : 'Connect');
  $('connect-button').disabled = connecting;
  renderMapPins();
  updateSelectedCountry();

  renderServers();
  updateTimer();
  updateSpeed();
}

function startConnection() {
  clearTimeout(connectionTimer);
  mode = 'connecting';
  render();
  connectionTimer = setTimeout(() => {
    mode = 'connected';
    started = Date.now();
    render();
  }, reducedMotion() ? 150 : 650);
}

function selectServer(id) {
  const destination = servers.find(server => server.id === id);
  const origin = servers.find(server => server.id === selected);
  if (!destination || id === selected) return;
  const reconnect = mode !== 'disconnected';
  clearTimeout(connectionTimer);
  selected = id;
  tooltipDismissed = false;
  mode = reconnect ? 'connecting' : 'disconnected';
  render();
  animateRoute(origin, destination, () => {
    if (reconnect) {
      mode = 'connected';
      started = Date.now();
    }
    render();
    requestAnimationFrame(() => focusServerOnMap(destination));
  });
}

function setPrimaryNavigation(active) {
  document.querySelector('.primary-nav').dataset.active = active;
  const map = { connection: 'connection-tab', settings: 'settings-tab', account: 'account-tab' };
  Object.entries(map).forEach(([key, id]) => {
    $(id).classList.toggle('active', key === active);
    if (key === active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  });
}

function showMap({ focusSearch = false } = {}) {
  const restoreFocus = !$('preferences').hidden && ($('preferences').contains(document.activeElement) || document.activeElement === $('about'));
  const returnTab = $('account-tab').hasAttribute('aria-current') ? $('account-tab') : $('settings-tab');
  $('preferences').hidden = true;
  $('map-panel').hidden = false;
  $('map-panel').inert = false;
  $('map-panel').removeAttribute('aria-hidden');
  $('workspace').classList.remove('preferences-open');
  $('locations-toggle').hidden = false;
  $('about').hidden = true;
  $('about').classList.remove('close-preferences');
  setPrimaryNavigation('connection');
  animateView($('map-panel'));
  scheduleMapTooltip();
  if (restoreFocus && !focusSearch) returnTab.focus({ preventScroll: true });

  if (focusSearch) {
    setLocationsCollapsed(false);
    if (window.innerWidth <= 800) {
      $('locations-panel').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
    $('search').focus({ preventScroll: true });
  }
}

function showPreferences(section) {
  $('map-panel').hidden = false;
  $('map-panel').inert = true;
  $('map-panel').setAttribute('aria-hidden', 'true');
  $('preferences').hidden = false;
  $('workspace').classList.add('preferences-open');
  $('locations-toggle').hidden = true;
  $('about').hidden = false;
  $('about').innerHTML = icon('close');
  $('about').setAttribute('aria-label', 'Close settings and return to connection map');
  $('about').classList.add('close-preferences');
  document.querySelectorAll('.preference-section').forEach(element => {
    element.hidden = element.id !== `section-${section}`;
  });
  document.querySelectorAll('[data-section]').forEach(element => {
    const active = element.dataset.section === section;
    element.classList.toggle('active', active);
    element.setAttribute('aria-selected', String(active));
    element.tabIndex = active ? 0 : -1;
  });
  document.querySelector('.preferences-tabs').dataset.active = section;
  document.querySelector('.preferences-tabs').hidden = section === 'account';
  $('map-tooltip').hidden = true;
  $('preferences-title').textContent = section === 'account' ? 'Account' : 'Settings';
  $('preferences-description').textContent = section === 'account'
    ? 'View your account and this device.'
    : section === 'relay'
      ? 'Understand the privacy layers behind your connection.'
      : 'Manage your connection and app experience.';
  setPrimaryNavigation(section === 'account' ? 'account' : 'settings');
  $('preferences').scrollTop = 0;
  animateView(document.querySelector(`#section-${section}`));
}

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

const authParents = {
  login: 'intro', register: 'intro', account: 'intro', forgot: 'login', otp: 'forgot', reset: 'otp'
};
const authNames = {
  intro: 'Welcome', login: 'Log in', register: 'Create account', account: 'Account number',
  forgot: 'Password recovery', otp: 'Verification', reset: 'New password'
};
let authView = 'intro';
let authCanClose = true;
let authReturnFocus = null;
let authData = { email: '' };

function authHeader(kicker, title, body) {
  return `<div class="auth-view-header">${kicker ? `<span class="auth-kicker">${kicker}</span>` : ''}<h1>${title}</h1><p>${body}</p></div>`;
}

function passwordField(id, label, placeholder = 'Enter your password') {
  return `<label class="auth-field"><span>${label}</span><div class="auth-input-wrap"><input id="${id}" name="${id}" type="password" autocomplete="current-password" placeholder="${placeholder}"><button class="auth-password-toggle" type="button" data-password-toggle="${id}" aria-label="Show ${label.toLowerCase()}">${icon('eye')}</button></div><small class="auth-error" data-error-for="${id}"></small></label>`;
}

function authViewMarkup(view) {
  if (view === 'intro') return `<div class="auth-view">
    ${authHeader('Welcome to Stellar VPN', 'Secure VPN,<br>without the noise.', 'Encrypt your internet traffic with Stellar VPN and choose how you want to continue.')}
    <div class="auth-options">
      <button class="auth-secondary" data-auth-action="account">Log in by account number</button>
      <button class="auth-primary" data-auth-action="login"><span>Log in</span></button>
    </div>
    <p class="auth-switch">Don’t have an account? <button data-auth-action="register">Create an account</button></p>
  </div>`;

  if (view === 'login') return `<form class="auth-view auth-form" data-auth-form="login" novalidate>
    ${authHeader('Welcome back', 'Log in', 'Enter your email and password to continue to Stellar VPN.')}
    <label class="auth-field"><span>Email</span><input id="login-email" name="email" type="email" autocomplete="email" value="${esc(authData.email)}" placeholder="you@example.com"><small class="auth-error" data-error-for="login-email"></small></label>
    ${passwordField('login-password', 'Password')}
    <div class="auth-form-row"><button class="auth-text-button" type="button" data-auth-action="forgot">Forgot password?</button></div>
    <button class="auth-primary" type="submit"><span>Log in</span></button>
    <p class="auth-switch">Don’t have an account? <button type="button" data-auth-action="register">Create an account</button></p>
  </form>`;

  if (view === 'register') return `<form class="auth-view auth-form" data-auth-form="register" novalidate>
    ${authHeader('New to Stellar', 'Create account', 'Create your free Stellar VPN account in a few seconds.')}
    <button class="auth-instant" type="button" data-auth-action="instant-register">${icon('sparkles')} One-click registration</button>
    <div class="auth-divider">or use email</div>
    <label class="auth-field"><span>Email</span><input id="register-email" name="email" type="email" autocomplete="email" value="${esc(authData.email)}" placeholder="you@example.com"><small class="auth-error" data-error-for="register-email"></small></label>
    ${passwordField('register-password', 'Password', 'At least 6 characters')}
    <button class="auth-primary" type="submit"><span>Create account</span></button>
    <p class="auth-switch">Already have an account? <button type="button" data-auth-action="login">Log in</button></p>
  </form>`;

  if (view === 'account') return `<form class="auth-view auth-form" data-auth-form="account" novalidate>
    ${authHeader('Alternative sign-in', 'Use account number', 'Enter the 16-digit account number connected to your Stellar VPN plan.')}
    <label class="auth-field"><span>Account number</span><input id="auth-account-number" class="auth-account-input" name="account" inputmode="numeric" autocomplete="off" maxlength="19" placeholder="0000 0000 0000 0000"><small class="auth-error" data-error-for="auth-account-number"></small></label>
    <button class="auth-primary" type="submit"><span>Log in</span></button>
  </form>`;

  if (view === 'forgot') return `<form class="auth-view auth-form" data-auth-form="forgot" novalidate>
    ${authHeader('Password recovery', 'Forgot password?', 'Enter your email to receive a four-digit verification code.')}
    <label class="auth-field"><span>Email</span><input id="forgot-email" name="email" type="email" autocomplete="email" value="${esc(authData.email)}" placeholder="you@example.com"><small class="auth-error" data-error-for="forgot-email"></small></label>
    <button class="auth-primary" type="submit"><span>Send code</span></button>
  </form>`;

  if (view === 'otp') return `<form class="auth-view auth-form" data-auth-form="otp" novalidate>
    ${authHeader('Check your inbox', 'Please input code', `We sent an account verification code to <strong>${esc(authData.email || 'your email')}</strong>.`)}
    <div class="auth-code" aria-label="Four-digit verification code">${[0,1,2,3].map(index => `<input aria-label="Digit ${index + 1}" inputmode="numeric" maxlength="1" pattern="[0-9]*" autocomplete="one-time-code">`).join('')}</div>
    <p class="auth-status" id="auth-code-status"></p>
    <button class="auth-primary" type="submit"><span>Verify code</span></button>
    <p class="auth-switch">Didn’t receive a code? <button type="button" data-auth-action="resend">Resend code</button></p>
  </form>`;

  return `<form class="auth-view auth-form" data-auth-form="reset" novalidate>
    ${authHeader('Almost done', 'Create new password', 'Choose a new password for your Stellar VPN account.')}
    ${passwordField('reset-password', 'New password', 'At least 6 characters')}
    ${passwordField('reset-confirm', 'Confirm password', 'Enter the same password again')}
    <button class="auth-primary" type="submit"><span>Confirm</span></button>
  </form>`;
}

function renderAuth(view = authView, direction = 1) {
  authView = view;
  $('auth-step-name').textContent = authNames[view];
  $('auth-back').hidden = view === 'intro';
  $('auth-close').hidden = !authCanClose;
  $('auth-legal').hidden = !['intro', 'login', 'register', 'account'].includes(view);
  $('auth-stage').innerHTML = authViewMarkup(view);
  $('auth-stage').firstElementChild?.classList.add(direction < 0 ? 'from-left' : 'from-right');
  requestAnimationFrame(() => $('auth-stage').querySelector('input, button')?.focus({ preventScroll: true }));
}

function navigateAuth(view, direction = 1) {
  if (!authNames[view] || view === authView) return;
  renderAuth(view, direction);
}

function startAuth({ canClose = true } = {}) {
  authReturnFocus = document.activeElement;
  authCanClose = canClose;
  authData = { email: '' };
  $('onboarding').hidden = true;
  document.body.classList.remove('onboarding-open');
  document.querySelector('.app').inert = true;
  document.querySelector('.app').setAttribute('aria-hidden', 'true');
  $('auth-flow').hidden = false;
  document.body.classList.add('auth-open');
  document.documentElement.classList.remove('auth-pending');
  renderAuth('intro');
}

function closeAuth() {
  if (!authCanClose) return;
  $('auth-flow').hidden = true;
  document.body.classList.remove('auth-open');
  document.querySelector('.app').inert = false;
  document.querySelector('.app').removeAttribute('aria-hidden');
  if (new URLSearchParams(location.search).has('auth')) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('auth');
    history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  }
  showMap();
  const focusTarget = authReturnFocus && authReturnFocus.offsetParent !== null ? authReturnFocus : $('map-panel');
  focusTarget?.focus?.({ preventScroll: true });
}

function authError(id, message) {
  const input = $(id);
  input?.setAttribute('aria-invalid', 'true');
  const error = document.querySelector(`[data-error-for="${id}"]`);
  if (error) error.textContent = message;
  input?.focus();
  return false;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function authLoading(form, callback) {
  const button = form.querySelector('.auth-primary[type="submit"]');
  button?.classList.add('auth-loading');
  form.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
  setTimeout(callback, reducedMotion() ? 80 : 480);
}

function startOnboardingAfterAuth() {
  setAuthenticated(true);
  $('auth-flow').hidden = true;
  document.body.classList.remove('auth-open');
  startOnboarding();
}

const onboardingPages = [
  {
    mode: 'trust',
    eyebrow: 'Privacy by design',
    title: 'Privacy that starts<br>with trust.',
    body: 'Stellar VPN is built around Swiss privacy principles. Your traffic is encrypted, and your activity is never logged.',
    features: [
      ['building', 'Based in Switzerland'],
      ['noLogs', 'No activity logs'],
      ['shield', 'Encrypted by default']
    ]
  },
  {
    mode: 'protection',
    eyebrow: 'Always protected',
    title: 'Secure wherever<br>you connect.',
    body: 'Protect public Wi-Fi, travel, and everyday browsing with one clear connection state.',
    features: [
      ['wifi', 'One-tap protection'],
      ['shield', 'Kill switch ready'],
      ['globe', 'Worldwide locations']
    ]
  },
  {
    mode: 'premium',
    eyebrow: 'Your privacy, your way',
    title: 'Choose how you<br>stay private.',
    body: 'Use Stellar Relay for multi-hop routing and Auto Rotate to refresh your route automatically.',
    features: [
      ['relay', 'Stellar Relay'],
      ['rotate', 'Auto Rotate'],
      ['shield', 'Kill switch']
    ]
  }
];

let onboardingPage = 0;
let onboardingReturnFocus = null;
let onboardingTouch = null;

function onboardingVisual(mode) {
  let content;
  if (mode === 'trust') {
    content = `<div class="privacy-emblem">${icon('shield')}</div>
      <div class="guide-heading"><span>BUILT AROUND YOUR PRIVACY</span><strong>Your activity stays yours.</strong></div>
      <div class="privacy-facts"><div>${icon('building')}<span>Swiss-based</span></div><div>${icon('noLogs')}<span>No activity logs</span></div></div>`;
  } else if (mode === 'protection') {
    const geography = [...$('world-countries').children].map(path => `<path d="${esc(path.getAttribute('d'))}"/>`).join('');
    content = `<svg class="guide-map" viewBox="520 155 180 140" aria-hidden="true">${geography}<circle class="guide-map-halo" cx="588.5" cy="197.5" r="9"/><circle class="guide-map-point" cx="588.5" cy="197.5" r="3"/></svg>
      <span class="guide-map-label">🇩🇰 Copenhagen</span>
      <div class="guide-connection"><span class="guide-status-icon">${icon('shield')}</span><div><span>CONNECTION</span><strong>Connected</strong><small>Copenhagen, Denmark</small></div><span class="guide-secure">Secure</span></div>`;
  } else {
    content = `<div class="guide-heading"><span>STELLAR RELAY</span><strong>One connection. Two privacy layers.</strong></div>
      <div class="guide-route"><div>${icon('computer')}<span>Your device</span></div><i>→</i><div>${icon('shield')}<span>Privacy core</span></div><i>→</i><div>${icon('globe')}<span>Exit location</span></div></div>
      <div class="guide-controls"><div>${icon('relay')}<span>Stellar Relay</span><small>Always on</small></div><div>${icon('rotate')}<span>Auto Rotate</span><small>Your choice</small></div><div>${icon('shield')}<span>Kill switch</span><small>Your choice</small></div></div>`;
  }
  return `<div class="onboarding-visual ${mode}-visual" aria-hidden="true">${content}</div>`;
}

function renderOnboarding(direction = 1) {
  const page = onboardingPages[onboardingPage];
  const stage = $('onboarding-stage');
  stage.scrollTop = 0;
  stage.innerHTML = `<article class="onboarding-page onboarding-page-${page.mode} ${direction < 0 ? 'from-left' : 'from-right'}">
    <div class="onboarding-copy">
      ${page.eyebrow ? `<span class="onboarding-badge">${icon(page.mode === 'trust' ? 'shield' : page.mode === 'protection' ? 'wifi' : 'settings')}${page.eyebrow}</span>` : ''}
      <h1>${page.title}</h1>
      <p>${page.body}</p>
      <div class="onboarding-features">
        ${page.features.map(([featureIcon, label]) => `<div><span>${icon(featureIcon)}</span><strong>${label}</strong></div>`).join('')}
      </div>
    </div>
    ${onboardingVisual(page.mode)}
  </article>`;

  $('onboarding-progress').innerHTML = onboardingPages.map((_, index) =>
    `<span class="${index === onboardingPage ? 'active' : ''}" aria-label="Step ${index + 1}${index === onboardingPage ? ', current' : ''}"></span>`
  ).join('');
  $('onboarding-step-label').textContent = `${onboardingPage + 1} of ${onboardingPages.length}`;
  $('onboarding-back').hidden = onboardingPage === 0;
  $('onboarding-skip').hidden = onboardingPage === onboardingPages.length - 1;
  $('onboarding-next').textContent = onboardingPage === onboardingPages.length - 1 ? 'Start with Stellar VPN' : 'Continue';
}

function setOnboardingPage(index) {
  if (index < 0 || index >= onboardingPages.length || index === onboardingPage) return;
  const direction = index > onboardingPage ? 1 : -1;
  onboardingPage = index;
  renderOnboarding(direction);
  if (window.matchMedia('(max-width: 800px)').matches) {
    requestAnimationFrame(() => $('onboarding').scrollTo({
      top: 0,
      behavior: reducedMotion() ? 'auto' : 'smooth'
    }));
  }
}

function startOnboarding() {
  onboardingReturnFocus = document.activeElement;
  onboardingPage = 0;
  $('auth-flow').hidden = true;
  document.body.classList.remove('auth-open');
  document.documentElement.classList.remove('auth-pending');
  document.querySelector('.app').inert = true;
  document.querySelector('.app').setAttribute('aria-hidden', 'true');
  $('onboarding').hidden = false;
  document.body.classList.add('onboarding-open');
  renderOnboarding();
  requestAnimationFrame(() => $('onboarding-next').focus({ preventScroll: true }));
}

function completeOnboarding() {
  $('onboarding').hidden = true;
  document.body.classList.remove('onboarding-open');
  document.querySelector('.app').inert = false;
  document.querySelector('.app').removeAttribute('aria-hidden');
  const previewParams = new URLSearchParams(location.search);
  if (previewParams.has('onboarding') || previewParams.has('auth')) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('onboarding');
    cleanUrl.searchParams.delete('auth');
    history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  }
  showMap();
  const focusTarget = onboardingReturnFocus && onboardingReturnFocus.offsetParent !== null ? onboardingReturnFocus : $('map-panel');
  focusTarget?.focus?.({ preventScroll: true });
}

$('locations-toggle').innerHTML = icon('panelHide');
$('search-icon').innerHTML = icon('search');
$('device-icon').innerHTML = icon('computer');
$('selected-server-arrow').innerHTML = icon('right');
document.querySelectorAll('[data-preference-icon]').forEach(element => {
  element.innerHTML = icon(element.dataset.preferenceIcon);
});
document.querySelectorAll('[data-feature-icon]').forEach(element => {
  const name = element.dataset.featureIcon;
  if (paths[name]) element.innerHTML = icon(name);
});
$('locations-toggle').addEventListener('click', () => setLocationsCollapsed(!locationsCollapsed));

$('server-list').addEventListener('click', event => {
  const favoriteButton = event.target.closest('[data-star]');
  if (favoriteButton) {
    const server = servers.find(item => item.id === favoriteButton.dataset.star);
    server.favorite = !server.favorite;
    renderServers();
    return;
  }
  const serverButton = event.target.closest('[data-select]');
  if (serverButton) selectServer(serverButton.dataset.select);
});

$('map-pins').addEventListener('click', event => {
  if (Date.now() < suppressMapClickUntil) {
    suppressMapClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const button = event.target.closest('[data-map]');
  if (button) selectServer(button.dataset.map);
});

for (const eventName of ['pointerover', 'focusin']) {
  $('map-pins').addEventListener(eventName, event => {
    const pin = event.target.closest('[data-map]');
    if (!pin) return;
    tooltipTarget = pin.dataset.map;
    tooltipDismissed = false;
    scheduleMapTooltip();
  });
}
for (const eventName of ['pointerout', 'focusout']) {
  $('map-pins').addEventListener(eventName, () => {
    tooltipTarget = null;
    scheduleMapTooltip();
  });
}
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('[data-map]')) {
    tooltipDismissed = true;
    scheduleMapTooltip();
  }
});

$('map-panel').addEventListener('pointerdown', event => {
  const mapPin = event.target.closest('.map-pin');
  const blockedControl = event.target.closest('button, input, .connection-card, .map-top, .map-bottom');
  if ((event.pointerType === 'mouse' && event.button !== 0) || (blockedControl && !mapPin)) return;
  stopMapMomentum();
  stopMapViewAnimation();
  suppressMapClickUntil = 0;
  mapDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: mapPan.x,
    originY: mapPan.y,
    lastX: event.clientX,
    lastY: event.clientY,
    lastTime: event.timeStamp,
    velocityX: 0,
    velocityY: 0,
    moved: false,
    serverId: mapPin?.dataset.map || null
  };
  $('map-panel').classList.add('is-dragging');
  $('map-panel').setPointerCapture(event.pointerId);
  event.preventDefault();
});

function moveMapDrag(event) {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  if (Math.hypot(event.clientX - mapDrag.startX, event.clientY - mapDrag.startY) > 5) mapDrag.moved = true;
  const elapsed = Math.max(1, event.timeStamp - mapDrag.lastTime);
  const instantX = (event.clientX - mapDrag.lastX) / elapsed;
  const instantY = (event.clientY - mapDrag.lastY) / elapsed;
  mapDrag.velocityX = mapDrag.velocityX * 0.58 + instantX * 0.42;
  mapDrag.velocityY = mapDrag.velocityY * 0.58 + instantY * 0.42;
  mapDrag.lastX = event.clientX;
  mapDrag.lastY = event.clientY;
  mapDrag.lastTime = event.timeStamp;
  setMapPan(
    mapDrag.originX + event.clientX - mapDrag.startX,
    mapDrag.originY + event.clientY - mapDrag.startY
  );
  event.preventDefault();
}

function endMapDrag(event) {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  const idleTime = Math.max(0, event.timeStamp - mapDrag.lastTime);
  const releaseFactor = Math.exp(-Math.max(0, idleTime - 28) / 55);
  const velocityX = mapDrag.velocityX * releaseFactor;
  const velocityY = mapDrag.velocityY * releaseFactor;
  const moved = mapDrag.moved;
  const serverId = mapDrag.serverId;
  suppressMapClickUntil = moved || serverId ? Date.now() + 160 : 0;
  mapDrag = null;
  $('map-panel').classList.remove('is-dragging');
  if (!moved && serverId) selectServer(serverId);
  startMapMomentum(velocityX, velocityY);
}

window.addEventListener('pointermove', moveMapDrag, { passive: false });
window.addEventListener('pointerup', endMapDrag);
window.addEventListener('pointercancel', endMapDrag);
$('map-panel').addEventListener('lostpointercapture', () => {
  mapDrag = null;
  $('map-panel').classList.remove('is-dragging');
});

$('map-panel').addEventListener('keydown', event => {
  const step = event.shiftKey ? 60 : 24;
  const movement = {
    ArrowLeft: [step, 0],
    ArrowRight: [-step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step]
  }[event.key];
  if (movement) {
    stopMapMomentum();
    stopMapViewAnimation();
    setMapPan(mapPan.x + movement[0], mapPan.y + movement[1]);
    event.preventDefault();
  } else if (event.key === 'Home') {
    resetMap();
    event.preventDefault();
  }
});

$('reset-map').addEventListener('click', resetMap);
$('zoom-out').addEventListener('click', () => zoomMapFromCenter(mapZoom / 1.25, true));
$('zoom-in').addEventListener('click', () => zoomMapFromCenter(mapZoom * 1.25, true));
$('map-panel').addEventListener('wheel', event => {
  stopMapMomentum();
  stopMapViewAnimation();
  clearTimeout(trackpadTimer);
  $('map-panel').classList.add('is-trackpad');
  trackpadTimer = setTimeout(() => $('map-panel').classList.remove('is-trackpad'), 140);

  if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
    const sensitivity = event.ctrlKey ? 0.008 : 0.003;
    const factor = Math.exp(-event.deltaY * sensitivity);
    zoomMapAt(event.clientX, event.clientY, mapZoom * factor);
  } else {
    setMapPan(mapPan.x - event.deltaX, mapPan.y);
  }
  event.preventDefault();
}, { passive: false });

$('map-panel').addEventListener('dblclick', event => {
  if (event.target.closest('button, input, .connection-card, .map-top, .map-bottom')) return;
  zoomMapAt(event.clientX, event.clientY, Math.max(mapZoom + 1.1, mapZoom * 1.8), true);
  event.preventDefault();
});
window.addEventListener('resize', () => {
  stopMapViewAnimation();
  setMapPan(mapPan.x, mapPan.y);
});

$('search').addEventListener('input', () => {
  renderServers();
  animateView($('server-list'));
});

for (const [id, value] of [['all', false], ['favorites', true]]) {
  $(id).addEventListener('click', () => {
    favorites = value;
    document.querySelector('.location-tabs').dataset.active = id;
    for (const key of ['all', 'favorites']) {
      const active = key === id;
      $(key).classList.toggle('active', active);
      $(key).setAttribute('aria-selected', String(active));
    }
    renderServers();
    animateView($('server-list'));
  });
}

$('connect-button').addEventListener('click', () => {
  if (mode === 'connected') {
    clearTimeout(connectionTimer);
    mode = 'disconnected';
    render();
  } else startConnection();
});

$('change-server').addEventListener('click', () => showMap({ focusSearch: true }));
$('home-logo').addEventListener('click', () => showMap());
$('connection-tab').addEventListener('click', () => showMap());
$('settings-tab').addEventListener('click', () => showPreferences('general'));
$('account-tab').addEventListener('click', () => showPreferences('account'));
$('replay-onboarding').addEventListener('click', startOnboarding);
$('auth-close').addEventListener('click', closeAuth);
$('auth-back').addEventListener('click', () => navigateAuth(authParents[authView] || 'intro', -1));
$('auth-stage').addEventListener('click', event => {
  const passwordToggle = event.target.closest('[data-password-toggle]');
  if (passwordToggle) {
    const input = $(passwordToggle.dataset.passwordToggle);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    passwordToggle.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} ${input.closest('.auth-field').querySelector(':scope > span').textContent.toLowerCase()}`);
    return;
  }

  const actionButton = event.target.closest('[data-auth-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.authAction;
  if (['login', 'register', 'account', 'forgot'].includes(action)) {
    navigateAuth(action);
  } else if (action === 'instant-register') {
    actionButton.classList.add('auth-loading');
    actionButton.disabled = true;
    setTimeout(startOnboardingAfterAuth, reducedMotion() ? 80 : 480);
  } else if (action === 'resend') {
    $('auth-code-status').textContent = 'A new code has been sent.';
    actionButton.disabled = true;
    notify('Verification code resent');
  }
});
$('auth-stage').addEventListener('input', event => {
  if (!event.target.matches('input')) return;
  event.target.removeAttribute('aria-invalid');
  const error = document.querySelector(`[data-error-for="${event.target.id}"]`);
  if (error) error.textContent = '';

  if (event.target.id === 'auth-account-number') {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 16);
    event.target.value = digits.replace(/(.{4})/g, '$1 ').trim();
  }

  if (event.target.closest('.auth-code')) {
    event.target.value = event.target.value.replace(/\D/g, '').slice(-1);
    if (event.target.value) {
      const fields = [...event.target.closest('.auth-code').querySelectorAll('input')];
      fields[fields.indexOf(event.target) + 1]?.focus();
    }
    $('auth-code-status').textContent = '';
    $('auth-code-status').classList.remove('error');
  }
});
$('auth-stage').addEventListener('keydown', event => {
  if (event.key !== 'Backspace' || !event.target.matches('.auth-code input') || event.target.value) return;
  const fields = [...event.target.closest('.auth-code').querySelectorAll('input')];
  fields[fields.indexOf(event.target) - 1]?.focus();
});
$('auth-stage').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const type = form.dataset.authForm;

  if (type === 'login') {
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    if (!validEmail(email)) return authError('login-email', 'Enter a valid email address.');
    if (!password) return authError('login-password', 'Enter your password.');
    authData.email = email;
    authLoading(form, startOnboardingAfterAuth);
  } else if (type === 'register') {
    const email = $('register-email').value.trim();
    const password = $('register-password').value;
    if (!validEmail(email)) return authError('register-email', 'Enter a valid email address.');
    if (password.length < 6) return authError('register-password', 'Use at least 6 characters.');
    authData.email = email;
    authLoading(form, startOnboardingAfterAuth);
  } else if (type === 'account') {
    if ($('auth-account-number').value.replace(/\D/g, '').length !== 16) return authError('auth-account-number', 'Enter all 16 digits.');
    authLoading(form, startOnboardingAfterAuth);
  } else if (type === 'forgot') {
    const email = $('forgot-email').value.trim();
    if (!validEmail(email)) return authError('forgot-email', 'Enter a valid email address.');
    authData.email = email;
    authLoading(form, () => navigateAuth('otp'));
  } else if (type === 'otp') {
    const code = [...form.querySelectorAll('.auth-code input')].map(input => input.value).join('');
    if (code.length !== 4) {
      $('auth-code-status').textContent = 'Enter the complete four-digit code.';
      $('auth-code-status').classList.add('error');
      form.querySelector('.auth-code input:placeholder-shown, .auth-code input[value=""]')?.focus();
      return;
    }
    authLoading(form, () => navigateAuth('reset'));
  } else if (type === 'reset') {
    const password = $('reset-password').value;
    const confirmation = $('reset-confirm').value;
    if (password.length < 6) return authError('reset-password', 'Use at least 6 characters.');
    if (confirmation !== password) return authError('reset-confirm', 'Passwords do not match.');
    authLoading(form, () => {
      navigateAuth('login');
      notify('Password updated. Log in to continue.');
    });
  }
});
$('onboarding-skip').addEventListener('click', completeOnboarding);
$('onboarding-back').addEventListener('click', () => setOnboardingPage(onboardingPage - 1));
$('onboarding-next').addEventListener('click', () => {
  if (onboardingPage === onboardingPages.length - 1) completeOnboarding();
  else setOnboardingPage(onboardingPage + 1);
});
$('onboarding-stage').addEventListener('pointerdown', event => {
  onboardingTouch = { x: event.clientX, y: event.clientY };
});
$('onboarding-stage').addEventListener('pointerup', event => {
  if (!onboardingTouch) return;
  const deltaX = event.clientX - onboardingTouch.x;
  const deltaY = event.clientY - onboardingTouch.y;
  onboardingTouch = null;
  if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
  setOnboardingPage(onboardingPage + (deltaX < 0 ? 1 : -1));
});
$('onboarding-stage').addEventListener('pointercancel', () => { onboardingTouch = null; });
$('preferences').addEventListener('click', event => {
  if (event.target === $('preferences')) showMap();
});

document.addEventListener('keydown', event => {
  if (!$('auth-flow').hidden && event.key === 'Escape') {
    if (authView !== 'intro') navigateAuth(authParents[authView] || 'intro', -1);
    else if (authCanClose) closeAuth();
    event.preventDefault();
    return;
  }
  if (!$('onboarding').hidden) {
    if (event.key === 'ArrowRight') setOnboardingPage(onboardingPage + 1);
    else if (event.key === 'ArrowLeft') setOnboardingPage(onboardingPage - 1);
    else if (event.key === 'Escape') completeOnboarding();
    else return;
    event.preventDefault();
    return;
  }
  if (event.key !== 'Escape') return;
  tooltipDismissed = true;
  scheduleMapTooltip();
  if (!$('language-options').hidden) {
    closeLanguageSelector(true);
    event.preventDefault();
    return;
  }
  if (!$('preferences').hidden && !document.querySelector('dialog[open]')) showMap();
});

document.querySelectorAll('[data-section]').forEach(button => {
  button.addEventListener('click', () => showPreferences(button.dataset.section));
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.preferences-tabs [role="tab"]')];
    const index = tabs.indexOf(button);
    let target;
    if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') target = tabs[0];
    else if (event.key === 'End') target = tabs.at(-1);
    else return;
    event.preventDefault();
    showPreferences(target.dataset.section);
    target.focus();
  });
});

$('about').addEventListener('click', () => {
  if (!$('preferences').hidden) showMap();
});

document.querySelectorAll('.close-dialog').forEach(button => {
  button.innerHTML = icon('close');
  button.addEventListener('click', () => closeDialog(button.closest('dialog')));
});

document.querySelectorAll('.close-dialog-text').forEach(button => {
  button.addEventListener('click', () => closeDialog(button.closest('dialog')));
});

document.querySelectorAll('dialog').forEach(dialog => {
  const heading = dialog.querySelector('h2');
  if (heading) {
    heading.id = `${dialog.id}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  let startedOutside = false;
  const isOutside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = isOutside(event); });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener('click', event => {
    if (startedOutside && isOutside(event)) closeDialog(dialog);
    startedOutside = false;
  });
});

function readSetting(name, fallback) {
  try {
    const value = localStorage.getItem(`stellar-vpn-${name}`);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeSetting(name, enabled) {
  try { localStorage.setItem(`stellar-vpn-${name}`, String(enabled)); } catch { /* local preview */ }
}

function isAuthenticated() {
  try {
    const value = localStorage.getItem('stellar-vpn-authenticated');
    return value === 'true';
  } catch {
    return false;
  }
}

function setAuthenticated(authenticated) {
  try { localStorage.setItem('stellar-vpn-authenticated', String(authenticated)); } catch { /* local preview */ }
}

function updateRotationCopy() {
  const enabled = document.querySelector('[data-setting="auto-rotate"]').getAttribute('aria-checked') === 'true';
  $('rotation-status').textContent = enabled ? 'Next rotation in 7 days' : 'Enable to rotate every 7 days';
}

document.querySelectorAll('.toggle[data-setting]').forEach(button => {
  const initial = readSetting(button.dataset.setting, button.getAttribute('aria-checked') === 'true');
  button.setAttribute('aria-checked', String(initial));
  button.addEventListener('click', () => {
    const enabled = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(enabled));
    writeSetting(button.dataset.setting, enabled);
    if (button.dataset.setting === 'auto-rotate') updateRotationCopy();
    renderPrivacyFeatures();
    notify(`${button.getAttribute('aria-label')} ${enabled ? 'enabled' : 'disabled'}`);
  });
});
updateRotationCopy();

const dialogCloseTimers = new WeakMap();

function closeDialog(dialog) {
  if (!dialog?.open || dialog.classList.contains('is-closing')) return;
  if (reducedMotion()) {
    dialog.close();
    return;
  }
  dialog.classList.add('is-closing');
  const timer = setTimeout(() => {
    dialog.classList.remove('is-closing');
    if (dialog.open) dialog.close();
    dialogCloseTimers.delete(dialog);
  }, 160);
  dialogCloseTimers.set(dialog, timer);
}

function openDialog(id, focusId) {
  const dialog = $(id);
  const timer = dialogCloseTimers.get(dialog);
  if (timer) clearTimeout(timer);
  dialogCloseTimers.delete(dialog);
  dialog.classList.remove('is-closing');
  dialog.showModal();
  if (focusId) requestAnimationFrame(() => $(focusId)?.focus());
}

$('auto-rotate-info').addEventListener('click', () => openDialog('auto-rotate-dialog'));

$('use-activation-code').addEventListener('click', () => openDialog('activation-dialog', 'activation-code'));
$('activate-code').addEventListener('click', () => {
  const value = $('activation-code').value.trim();
  if (!value) {
    $('activation-code').focus();
    notify('Enter an activation code');
    return;
  }
  closeDialog($('activation-dialog'));
  $('activation-code').value = '';
  notify('Activation code ready to verify');
});
$('manage-plan').addEventListener('click', () => openDialog('plan-dialog'));
$('plan-activation').addEventListener('click', () => {
  closeDialog($('plan-dialog'));
  setTimeout(() => {
    $('use-activation-code').focus();
    openDialog('activation-dialog', 'activation-code');
  }, reducedMotion() ? 0 : 180);
});
$('trust-and-privacy').addEventListener('click', () => openDialog('trust-dialog'));
$('logout').addEventListener('click', () => openDialog('logout-dialog'));
$('confirm-logout').addEventListener('click', () => {
  clearTimeout(connectionTimer);
  mode = 'disconnected';
  setAuthenticated(false);
  render();
  closeDialog($('logout-dialog'));
  setTimeout(() => startAuth({ canClose: false }), reducedMotion() ? 0 : 170);
});

let languageCloseTimer;

function closeLanguageSelector(restoreFocus = false) {
  const options = $('language-options');
  if (options.hidden || options.classList.contains('is-closing')) return;
  $('language-trigger').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('language-trigger').focus();
  if (reducedMotion()) {
    options.hidden = true;
    return;
  }
  options.classList.add('is-closing');
  languageCloseTimer = setTimeout(() => {
    options.hidden = true;
    options.classList.remove('is-closing');
    languageCloseTimer = undefined;
  }, 150);
}

function openLanguageSelector() {
  if (languageCloseTimer) clearTimeout(languageCloseTimer);
  languageCloseTimer = undefined;
  $('language-options').classList.remove('is-closing');
  $('language-options').hidden = false;
  $('language-trigger').setAttribute('aria-expanded', 'true');
  const options = $('language-options');
  const trigger = $('language-trigger').getBoundingClientRect();
  const height = options.offsetHeight;
  options.classList.toggle('opens-down', trigger.top < height + 12 && innerHeight - trigger.bottom >= height + 12);
  requestAnimationFrame(() => document.querySelector('#language-options [aria-selected="true"]')?.focus());
}

$('language-trigger').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  openLanguageSelector();
});

$('language-trigger').addEventListener('click', () => {
  if ($('language-options').hidden) openLanguageSelector();
  else closeLanguageSelector();
});

document.querySelectorAll('#language-options [role="option"]').forEach(option => {
  option.addEventListener('click', () => {
    const language = option.dataset.language;
    $('language-value').textContent = language;
    $('language-flag').textContent = option.querySelector('small').textContent;
    $('language-trigger').setAttribute('aria-label', `Language: ${language}`);
    document.querySelectorAll('#language-options [role="option"]').forEach(item => item.setAttribute('aria-selected', String(item === option)));
    closeLanguageSelector(true);
    notify(`${language} selected`);
  });
  option.addEventListener('keydown', event => {
    const options = [...document.querySelectorAll('#language-options [role="option"]')];
    const index = options.indexOf(option);
    if (event.key === 'ArrowDown') options[(index + 1) % options.length].focus();
    else if (event.key === 'ArrowUp') options[(index - 1 + options.length) % options.length].focus();
    else if (event.key === 'Home') options[0].focus();
    else if (event.key === 'End') options.at(-1).focus();
    else return;
    event.preventDefault();
  });
});

document.addEventListener('pointerdown', event => {
  if (!$('language-options').hidden && !event.target.closest('#language-selector')) closeLanguageSelector();
});

$('reveal-account').addEventListener('click', () => {
  const shown = $('reveal-account').getAttribute('aria-pressed') !== 'true';
  $('reveal-account').setAttribute('aria-pressed', String(shown));
  $('reveal-account').textContent = shown ? 'Hide' : 'Show';
  $('account-number').textContent = shown ? '8237 6194 4821 3065' : '•••• •••• •••• 3065';
});

$('copy-account').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('8237 6194 4821 3065');
    notify('Account ID copied');
  } catch {
    notify('Could not copy. Show and select the ID instead.');
  }
});

const labels = [
  ['North America', -105, 45], ['South America', -60, -22], ['Europe', 16, 53],
  ['Africa', 20, 4], ['Asia', 88, 42], ['Oceania', 137, -24]
];

$('map-labels').innerHTML = labels.map(([name, lon, lat]) => `<span class="map-label" style="${placement(lon, lat)}">${name}</span>`).join('');

async function initializeApp() {
  const preview = new URLSearchParams(location.search);
  const requiresAuth = preview.get('auth') === '1'
    || (preview.get('onboarding') !== '1' && !isAuthenticated());

  if (requiresAuth) startAuth({ canClose: preview.get('auth') === '1' });

  await loadServerData();
  setPrimaryNavigation('connection');
  await renderWorldMap();
  render();
  if (preview.get('onboarding') === '1') startOnboarding();
  setInterval(() => {
    if (!document.hidden) {
      updateTimer();
      updateSpeed();
    }
  }, 1000);
}

initializeApp();
