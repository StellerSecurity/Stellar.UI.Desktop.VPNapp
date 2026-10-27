import { useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { filterServers } from '../domain/Server';
import { Icon } from '../../../shared/ui/Icon';

export function LocationsPanel() {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const servers = filterServers(app.servers, query, favorites ? app.favoriteIds : null);
  return <aside className="locations" id="locations-panel" aria-label="VPN locations">
    <div className="locations-heading"><h1>Choose a server</h1></div>
    <label className="search"><span id="search-icon"><Icon name="search" /></span>
      <input id="search" type="search" placeholder="Search country or city" aria-label="Search country or city" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="location-tabs" role="tablist" aria-label="Filter locations" data-active={favorites ? 'favorites' : 'all'}>
      <span className="selection-indicator" aria-hidden="true" />
      {[false, true].map(favorite => <button key={String(favorite)} id={favorite ? 'favorites' : 'all'} role="tab" aria-selected={favorite === favorites} tabIndex={favorite === favorites ? 0 : -1} className={favorite === favorites ? 'active' : ''} onClick={() => setFavorites(favorite)} onKeyDown={event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? false : event.key === 'End' ? true : !favorites;
          setFavorites(next); document.getElementById(next ? 'favorites' : 'all')?.focus();
        }
      }}>{favorite ? 'Favorites' : 'All'}</button>)}
    </div>
    <div className="server-heading"><span>{servers.length} locations</span></div>
    <div key={`${favorites}-${query}`} id="server-list" className={`server-list view-enter ${servers.length ? '' : 'is-empty'}`} role="list" aria-label="Available locations">
      {servers.map(server => {
        const selected = app.selectedId === server.id;
        const favorite = app.favoriteIds.includes(server.id);
        return <div key={server.id} className={`server-row ${selected ? `selected ${app.pending ? 'connecting' : app.snapshot?.connection.status}` : ''}`} role="listitem">
          <button className="server-select" data-select={server.id} aria-current={selected} aria-label={`Choose ${server.country}, ${server.city}`} onClick={() => app.selectServer(server.id)}>
            <span className="flag" aria-hidden="true">{server.flag}</span><span className="server-copy"><strong className="server-name">{server.country}</strong><span className="server-city"> · {server.city}</span></span>
            <span className="selected-check" aria-hidden="true"><span>{selected ? app.pending ? '' : app.snapshot?.connection.status === 'connected' ? 'Connected' : 'Selected' : ''}</span><Icon name="check" /></span>
          </button>
          <button className={`server-star ${favorite ? 'active' : ''}`} aria-label={`${favorite ? 'Remove' : 'Add'} ${server.country} ${favorite ? 'from' : 'to'} favorites`} aria-pressed={favorite} onClick={() => app.toggleFavorite(server.id)}><Icon name="star" /></button>
        </div>;
      })}
    </div>
    {!servers.length && <div className="server-empty" id="server-empty">{favorites && !query ? 'No favorites yet. Add a location with the star.' : 'No locations match your search.'}</div>}
  </aside>;
}
