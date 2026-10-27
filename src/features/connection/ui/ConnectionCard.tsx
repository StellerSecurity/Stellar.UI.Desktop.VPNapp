import { useEffect, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Loading } from '../../../shared/ui/Loading';
import { elapsedTime } from '../domain/Connection';

export function ConnectionCard() {
  const app = useApp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const connected = app.snapshot?.connection.status === 'connected';
  return <section className="connection-card" aria-labelledby="status-title" aria-busy={app.pending}>
    <div className="connection-heading"><span className="status-symbol" id="status-symbol"><Icon name={connected ? 'shield' : 'power'} /></span><div><h2 id="status-title">{app.pending ? <Loading label="Loading connection" /> : connected ? 'Connected' : 'Disconnected'}</h2></div></div>
    <button className="selected-server" id="change-server" aria-label="Choose another location" onClick={() => { app.setCollapsed(false); document.getElementById('search')?.focus(); }}>
      <span className="flag" id="selected-flag">{app.selected?.flag}</span><span className="selected-server-copy"><strong id="selected-country">{app.selected?.country}</strong><span id="selected-city">{app.selected?.city} · {app.selected?.id}</span></span>
    </button>
    <div className="connection-facts"><div aria-label="Connection time"><span>Time</span><strong id="session-time">{elapsedTime(connected ? app.snapshot!.connection.connectedAt : null, now)}</strong></div><div><span>Speed · Mbps</span><strong id="traffic-speed" title="Network measurements become available with the VPN engine">—</strong></div></div>
    <button id="connect-button" className="connect-button" disabled={app.pending} onClick={() => void (connected ? app.disconnect() : app.connect())}>{app.pending ? <Loading label="Loading connection" /> : <><Icon name="power" />{connected ? 'Disconnect' : 'Connect'}</>}</button>
  </section>;
}
