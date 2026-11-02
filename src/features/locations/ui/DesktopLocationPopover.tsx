import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LocationsPanel } from './LocationsPanel';

export function DesktopLocationPopover({ open, trigger, onClose }: {
  open: boolean; trigger: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [anchor, setAnchor] = useState({ left: 16, bottom: 160, width: 432, height: 500 });
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(rect.width, window.innerWidth - 32);
      setAnchor({ width, left: Math.max(16, Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2)),
        bottom: window.innerHeight - rect.top + 12, height: Math.min(560, Math.max(160, rect.top - 80)) });
    };
    position(); window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open, trigger]);
  useEffect(() => {
    if (open) {
      panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
      panel.current?.querySelector('[data-select][aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    } else if (wasOpen.current) trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open, trigger]);
  // Keep the panel mounted to retain search and favorites through dismissal and its closing animation.
  return createPortal(<div className="desktop-location-layer" data-open={open} inert={!open} aria-hidden={!open}
    onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}>
    <div ref={panel} id="desktop-location-popover" className="desktop-location-popover" role="dialog" aria-modal="true" aria-labelledby="locations-title" style={anchor}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)') || [])];
        if (event.key === 'Tab') {
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
          return;
        }
        const options = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-select]') || [])];
        const index = options.indexOf(event.target as HTMLButtonElement);
        if (event.target instanceof HTMLInputElement && event.key === 'ArrowDown') {
          event.preventDefault(); (options.find(option => option.getAttribute('aria-current') === 'true') || options[0])?.focus();
        } else if (index >= 0 && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length;
          options[next]?.focus();
        }
      }}>
      <LocationsPanel variant="picker" onChoose={onClose} onClose={onClose} />
    </div>
  </div>, document.body);
}
