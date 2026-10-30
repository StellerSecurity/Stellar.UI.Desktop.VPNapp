import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { filterServers, type Server } from '../../locations/domain/Server';
import { Icon } from '../../../shared/ui/Icon';
import { CountryFlag } from '../../../shared/ui/CountryFlag';

export function TrayLocationPicker({ servers, selectedId, busy, onSelect, onClose }: {
  servers: readonly Server[]; selectedId: string; busy: boolean;
  onSelect: (id: string) => void; onClose: () => void;
}) {
  const t = useTranslation();
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(selectedId);
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const results = filterServers(servers, '', null).filter(server => !query || filterServers([server], query, null).length || t(server.country).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const index = Math.max(0, results.findIndex(server => server.id === highlighted));
  const activeId = results[index]?.id;
  function close() {
    if (closing) return;
    setClosing(true);
    timer.current = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140);
  }
  function choose(id: string) {
    if (busy || closing) return;
    onSelect(id); close();
  }
  useEffect(() => { input.current?.focus(); return () => clearTimeout(timer.current); }, []);
  useEffect(() => {
    root.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  return <div className="tray-picker-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={root} className={`tray-picker ${closing ? 'is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="tray-picker-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') {
        const first = root.current?.querySelector<HTMLButtonElement>('button');
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); input.current?.focus(); }
        else if (!event.shiftKey && document.activeElement === input.current) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.target !== input.current || busy || closing) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        if (results[next]) setHighlighted(results[next].id);
      } else if (event.key === 'Enter' && activeId) { event.preventDefault(); choose(activeId); }
    }}>
      <header><h2 id="tray-picker-title">{t("Choose a location")}</h2><button type="button" aria-label={t("Close location picker")} onClick={close}><Icon name="close" /></button></header>
      <label className="tray-picker-search"><Icon name="search" /><input ref={input} role="combobox" aria-label={t("Search country, city or country code")} aria-expanded="true" aria-autocomplete="list" aria-controls="tray-location-options" aria-activedescendant={activeId ? `tray-option-${activeId}` : undefined} placeholder={t("Search country or city")} value={query} onChange={event => { setQuery(event.target.value); setHighlighted(''); }} /></label>
      <div id="tray-location-options" role="listbox" aria-label={t("VPN locations")} aria-busy={busy} className="tray-picker-results">
        {t(results.map(server => <button type="button" key={server.id} id={`tray-option-${server.id}`} role="option" aria-selected={server.id === selectedId} data-highlighted={server.id === activeId} tabIndex={-1} disabled={busy || closing} onPointerDown={event => event.preventDefault()} onPointerMove={() => setHighlighted(server.id)} onClick={() => choose(server.id)}>
          <CountryFlag code={server.countryCode} className="tray-option-flag" /><span><strong>{t(server.country)}</strong><small>{t(server.city)}</small></span><span className="tray-option-check">{t(server.id === selectedId && <Icon name="check" />)}</span>
        </button>))}
        {t(!results.length && <p role="status">{t(servers.length ? 'No matching locations' : 'No saved locations yet. Open Stellar VPN to load them.')}</p>)}
      </div>
    </section>
  </div>;
}
