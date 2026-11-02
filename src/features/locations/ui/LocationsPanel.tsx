import { useLocale, useTranslation } from '../../../shared/i18n/I18n';
import { useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { filterServers } from '../domain/Server';
import { groupServers } from '../domain/ServerRegions';
import { Icon } from '../../../shared/ui/Icon';
import { Skeleton } from '../../../shared/ui/Skeleton';
import { CountryFlag } from '../../../shared/ui/CountryFlag';

export function LocationsPanel({ variant = 'sidebar', onChoose, onClose }: { variant?: 'sidebar' | 'picker'; onChoose?: () => void; onClose?: () => void }) {
  const t = useTranslation();
  const locale = useLocale();
  const app = useApp();
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const servers = filterServers(app.servers, '', favorites ? app.favoriteIds : null)
    .filter(server => !query || filterServers([server], query, null).length || t(server.country).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => t(a.country).localeCompare(t(b.country), locale) || a.city.localeCompare(b.city, locale));
  return <aside className={`locations ${variant === 'picker' ? 'locations-picker' : ''}`} id="locations-panel" aria-label={t("VPN locations")}>
    <div className="locations-heading"><h1 id="locations-title">{t("Choose a server")}</h1>{t(onClose && <button className="locations-close" aria-label={t("Close server picker")} onClick={onClose}><Icon name="close" /></button>)}</div>
    <label className="search"><span id="search-icon"><Icon name="search" /></span>
      <input id="search" type="search" placeholder={t("Search country or city")} aria-label={t("Search country or city")} autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="location-tabs" role="tablist" aria-label={t("Filter locations")} data-active={favorites ? 'favorites' : 'all'}>
      <span className="selection-indicator" aria-hidden="true" />
      {t([false, true].map(favorite => <button key={String(favorite)} id={favorite ? 'favorites' : 'all'} role="tab" aria-selected={favorite === favorites} tabIndex={favorite === favorites ? 0 : -1} className={favorite === favorites ? 'active' : ''} onClick={() => setFavorites(favorite)} onKeyDown={event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? false : event.key === 'End' ? true : !favorites;
          setFavorites(next); document.getElementById(next ? 'favorites' : 'all')?.focus();
        }
      }}>{t(favorite ? 'Favorites' : 'All')}</button>))}
    </div>
    <div className="server-heading"><span>{t(app.catalogStatus === 'loading' && !app.servers.length ? <Skeleton className="skeleton-label" /> : app.catalogStatus === 'error' && !app.servers.length ? 'Locations unavailable' : `${servers.length} ${servers.length === 1 ? 'location' : 'locations'}`)}</span>{t(app.catalogStatus === 'error' && !!app.servers.length && <button className="catalog-cache-status" onClick={app.retryCatalog} title={t("Showing saved locations. Retry updating the list.")}>{t("Saved · Retry")}</button>)}</div>
    {t(app.catalogStatus === 'loading' && !app.servers.length && <div className="locations-skeleton" role="status" aria-label={t("Loading locations")} aria-busy="true">{t([0, 1, 2, 3, 4, 5].map(row => <div className="skeleton-location" key={row}><Skeleton className="skeleton-flag" /><Skeleton className="skeleton-line" /></div>))}</div>)}
    <div key={`${favorites}-${query}`} id="server-list" className={`server-list grouped-server-list view-enter ${servers.length ? '' : 'is-empty'}`} aria-label={t("Available locations")}>
      {groupServers(servers).map(group => <section className="server-region" key={group.region} aria-label={t(group.region)}>
        <h2 className="server-region-heading">{t(group.region)}<span>{group.servers.length}</span></h2>
        <div className="server-region-list" role="list" aria-label={t(group.region)}>
      {t(group.servers.map(server => {
        const selected = app.selectedId === server.id;
        const favorite = app.favoriteIds.includes(server.id);
        return <div key={server.id} className={`server-row ${selected ? `selected ${app.pending ? 'connecting' : app.snapshot?.connection.status}` : ''}`} role="listitem">
          <button className="server-select" data-select={server.id} aria-current={selected} aria-label={t(`Choose ${t(server.country)}, ${server.city}`)} onClick={() => { app.selectServer(server.id); onChoose?.(); }}>
            {t(variant === 'picker' ? <CountryFlag code={server.countryCode} className="picker-country-flag" /> : <span className="flag" aria-hidden="true">{t(server.flag)}</span>)}<span className="server-copy"><strong className="server-name">{t(server.country)}</strong><span className="server-city">{t(variant === 'picker' ? server.city : ` · ${server.city}`)}</span></span>
            <span className="selected-check" aria-hidden="true"><span>{t(selected ? app.pending ? '' : app.snapshot?.connection.status === 'connected' ? 'Connected' : 'Selected' : '')}</span><Icon name="check" /></span>
          </button>
          <button className={`server-star ${favorite ? 'active' : ''}`} aria-label={t(`${favorite ? 'Remove' : 'Add'} ${t(server.country)} ${favorite ? 'from' : 'to'} favorites`)} aria-pressed={favorite} onClick={() => app.toggleFavorite(server.id)}><Icon name="star" /></button>
        </div>;
      }))}
        </div>
      </section>)}
    </div>
    {t(app.catalogStatus === 'error' && !app.servers.length ? <div className="server-empty" id="server-empty" role="alert"><p>{t(app.catalogError)}</p><button className="catalog-retry" onClick={app.retryCatalog}>{t("Try again")}</button></div>
      : app.catalogStatus !== 'loading' && !servers.length && <div className="server-empty" id="server-empty" role="status">{t(favorites && !query ? 'No favorites yet. Add a location with the star.' : 'No locations match your search.')}</div>)}
  </aside>;
}
