import { mapPoint, type Coordinate } from '../domain/geometry';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Imperative rendering isolated here keeps pointer/animation frames out of React state. */
export class MapViewport {
  x = 0; y = 0; zoom = 1.22;
  private animation = 0;
  private momentum = 0;
  private abort = new AbortController();
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private gestureZoom = 1.22;
  private drag: null | { id: number; x: number; y: number; ox: number; oy: number; lx: number; ly: number; time: number; vx: number; vy: number; moved: boolean; server: string | null } = null;
  private root: HTMLElement;
  private frame: HTMLElement;
  private art: HTMLElement;
  private onChange: () => void;
  private onSelect: (id: string) => void;
  private collapsed: () => boolean;
  constructor(root: HTMLElement, onChange: () => void, onSelect: (id: string) => void, collapsed: () => boolean) {
    this.root = root; this.frame = root.querySelector('.map-art-frame')!; this.art = root.querySelector('.map-art')!;
    this.onChange = onChange; this.onSelect = onSelect; this.collapsed = collapsed;
    const options = { signal: this.abort.signal };
    root.addEventListener('pointerdown', this.down, options);
    root.addEventListener('pointermove', this.move, options);
    root.addEventListener('pointerup', this.up, options);
    root.addEventListener('pointercancel', this.cancel, options);
    root.addEventListener('wheel', this.wheel, { ...options, passive: false });
    root.addEventListener('gesturestart', this.gestureStart, { ...options, passive: false });
    root.addEventListener('gesturechange', this.gestureChange, { ...options, passive: false });
    root.addEventListener('gestureend', this.gestureEnd, { ...options, passive: false });
    root.addEventListener('dblclick', this.doubleClick, options);
    root.addEventListener('keydown', this.keydown, options);
    window.addEventListener('resize', this.resize, options);
    this.paint();
  }
  private blocked(target: EventTarget | null) { return target instanceof Element && !!target.closest('button:not(.map-pin), input, .connection-card, .map-top, .map-bottom'); }
  private stop() { cancelAnimationFrame(this.animation); cancelAnimationFrame(this.momentum); this.animation = 0; this.momentum = 0; }
  private limits() {
    // Permit moving either edge of the world into the usable map area, even behind an open sidebar.
    const clearance = this.collapsed() ? 0 : Math.min(360, this.root.clientWidth * .36);
    return { x: Math.max(300, this.frame.offsetWidth * this.zoom / 2 + clearance), y: Math.max(160, this.frame.offsetHeight * this.zoom / 2) };
  }
  private paint() {
    const limits = this.limits(); this.x = clamp(this.x, -limits.x, limits.x); this.y = clamp(this.y, -limits.y, limits.y);
    this.art.style.width = `${this.frame.offsetWidth * this.zoom}px`;
    this.art.style.height = `${this.frame.offsetHeight * this.zoom}px`;
    this.art.style.setProperty('--map-pan-x', `${this.x}px`);
    this.art.style.setProperty('--map-pan-y', `${this.y}px`);
    this.art.style.setProperty('--map-zoom', String(this.zoom));
    this.root.classList.toggle('map-overview', this.zoom < 1.7);
    const reset = this.root.querySelector<HTMLButtonElement>('#reset-map');
    if (reset) reset.hidden = Math.abs(this.x) < 1 && Math.abs(this.y) < 1 && Math.abs(this.zoom - 1.22) < .01;
    this.onChange();
  }
  private animate(x: number, y: number, zoom: number) {
    this.stop(); const sx = this.x, sy = this.y, sz = this.zoom, started = performance.now();
    const targetZoom = clamp(zoom, .85, 8);
    if (reducedMotion()) { this.x = x; this.y = y; this.zoom = targetZoom; this.paint(); return; }
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 440), eased = 1 - (1 - t) ** 3;
      this.x = sx + (x - sx) * eased; this.y = sy + (y - sy) * eased; this.zoom = sz + (targetZoom - sz) * eased; this.paint();
      if (t < 1) this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }
  reset = () => this.animate(0, 0, 1.22);
  focus(server: Coordinate) {
    const p = mapPoint(server), zoom = Math.max(this.zoom, 2.1);
    this.animate(this.root.clientWidth * (this.collapsed() ? 0 : .16) - (p.x / 1100 - .5) * this.frame.offsetWidth * zoom,
      -this.root.clientHeight * .1 - (p.y / 760 - .5) * this.frame.offsetHeight * zoom, zoom);
  }
  zoomAt(clientX: number, clientY: number, requested: number, animated = false) {
    this.stop(); const rect = this.root.getBoundingClientRect(), x = clientX - rect.left - this.root.clientWidth / 2, y = clientY - rect.top - this.root.clientHeight / 2;
    const zoom = clamp(requested, .85, 8), ratio = zoom / this.zoom;
    const targetX = x - (x - this.x) * ratio, targetY = y - (y - this.y) * ratio;
    if (animated) this.animate(targetX, targetY, zoom);
    else { this.x = targetX; this.y = targetY; this.zoom = zoom; this.paint(); }
  }
  zoomBy(factor: number) {
    const rect = this.root.getBoundingClientRect();
    this.zoomAt(rect.left + this.root.clientWidth * (this.collapsed() ? .5 : .66), rect.top + this.root.clientHeight * .4, this.zoom * factor, true);
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0 || this.blocked(event.target)) return;
    this.stop(); this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.root.setPointerCapture(event.pointerId);
    if (this.pointers.size === 2) { this.drag = null; this.pinchDistance = this.pointerDistance(); return; }
    // A large selected halo must not steal a neighboring city's center hit target.
    let pin: HTMLElement | null = null, nearest = Infinity;
    for (const candidate of this.root.querySelectorAll<HTMLElement>('[data-map]')) {
      const box = candidate.getBoundingClientRect();
      const distance = Math.hypot(event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2);
      if (distance <= Math.max(14, box.width / 2) && distance < nearest) { pin = candidate; nearest = distance; }
    }
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: this.x, oy: this.y, lx: event.clientX, ly: event.clientY, time: event.timeStamp, vx: 0, vy: 0, moved: false, server: pin?.dataset.map || null };
    this.root.classList.add('is-dragging'); event.preventDefault();
  };
  private pointerDistance() { const [a, b] = [...this.pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; }
  private move = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      const distance = this.pointerDistance(), [a, b] = [...this.pointers.values()];
      if (this.pinchDistance > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.zoom * distance / this.pinchDistance);
      this.pinchDistance = distance; event.preventDefault(); return;
    }
    const d = this.drag; if (!d || d.id !== event.pointerId) return;
    d.moved ||= Math.hypot(event.clientX - d.x, event.clientY - d.y) > 5;
    const dt = Math.max(1, event.timeStamp - d.time);
    d.vx = d.vx * .58 + (event.clientX - d.lx) / dt * .42; d.vy = d.vy * .58 + (event.clientY - d.ly) / dt * .42;
    d.lx = event.clientX; d.ly = event.clientY; d.time = event.timeStamp;
    this.x = d.ox + event.clientX - d.x; this.y = d.oy + event.clientY - d.y; this.paint(); event.preventDefault();
  };
  private up = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId); if (this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
    const d = this.drag; this.drag = null; this.root.classList.remove('is-dragging');
    if (!d || d.id !== event.pointerId) return;
    if (!d.moved && d.server) this.onSelect(d.server);
    if (!d.moved || reducedMotion()) return;
    const decay = Math.exp(-Math.max(0, event.timeStamp - d.time - 28) / 55);
    let vx = d.vx * decay, vy = d.vy * decay, last = performance.now();
    const glide = (now: number) => {
      const dt = Math.min(32, now - last); last = now;
      this.x += vx * dt; this.y += vy * dt; this.paint();
      vx *= .9 ** (dt / 16.67); vy *= .9 ** (dt / 16.67);
      if (Math.hypot(vx, vy) > .018) this.momentum = requestAnimationFrame(glide);
    };
    this.momentum = requestAnimationFrame(glide);
  };
  private cancel = () => { this.pointers.clear(); this.drag = null; this.root.classList.remove('is-dragging'); };
  private wheel = (event: WheelEvent) => {
    if (this.blocked(event.target)) return;
    event.preventDefault(); this.stop();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.root.clientHeight : 1;
    if (event.ctrlKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) this.zoomAt(event.clientX, event.clientY, this.zoom * Math.exp(-event.deltaY * unit * (event.ctrlKey ? .008 : .003)));
    else { this.x -= event.deltaX * unit; this.y -= event.deltaY * unit; this.paint(); }
  };
  private doubleClick = (event: MouseEvent) => { if (!this.blocked(event.target)) { event.preventDefault(); this.zoomAt(event.clientX, event.clientY, Math.max(this.zoom + 1.1, this.zoom * 1.8), true); } };
  private gestureStart = (event: Event) => { if (!this.blocked(event.target)) { event.preventDefault(); this.stop(); this.gestureZoom = this.zoom; } };
  private gestureChange = (event: Event) => {
    if (this.blocked(event.target)) return;
    const gesture = event as Event & { scale: number; clientX: number; clientY: number };
    if (!Number.isFinite(gesture.scale)) return;
    event.preventDefault();
    const rect = this.root.getBoundingClientRect();
    this.zoomAt(gesture.clientX || rect.left + rect.width * .66, gesture.clientY || rect.top + rect.height * .4, this.gestureZoom * gesture.scale);
  };
  private gestureEnd = (event: Event) => { if (!this.blocked(event.target)) event.preventDefault(); };
  private keydown = (event: KeyboardEvent) => {
    if (event.target !== this.root) return;
    const step = event.shiftKey ? 60 : 24;
    const move: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (move[event.key]) { event.preventDefault(); this.stop(); this.x += move[event.key][0]; this.y += move[event.key][1]; this.paint(); }
    if (event.key === 'Home') { event.preventDefault(); this.reset(); }
  };
  private resize = () => { this.stop(); this.paint(); };
  destroy() { this.stop(); this.abort.abort(); }
}
