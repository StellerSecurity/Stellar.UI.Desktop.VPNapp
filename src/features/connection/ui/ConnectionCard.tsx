import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { elapsedTime } from '../domain/Connection';
import { compactConnectionLayout } from '../domain/ConnectionLayout';
import { CompactConnectionDock } from './CompactConnectionDock';

export function ConnectionCard() {
  return compactConnectionLayout ? <CompactConnectionDock /> : <ClassicConnectionCard />;
}

function ClassicConnectionCard() {
  const t = useTranslation();
  const app = useApp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const connected = app.snapshot?.connection.status === 'connected';
  const blocked = !!app.snapshot?.connection.trafficBlocked;
  const traffic = app.snapshot?.connection;
  const measured = connected && typeof traffic?.downloadMbps === 'number' && typeof traffic?.uploadMbps === 'number';
  const pendingLabel = app.pendingAction === 'disconnect' ? 'Disconnecting…' : 'Connecting…';
  return <section className="connection-card" aria-labelledby="status-title" aria-busy={app.pending}>
    <div className="connection-heading"><span className="status-symbol" id="status-symbol"><Icon name={!app.pending && connected ? 'shield' : 'power'} /></span><div><h2 id="status-title" role="status" aria-live="polite">{t(app.pending ? pendingLabel : connected ? 'Connected' : blocked ? 'Internet blocked' : 'Disconnected')}</h2></div></div>
    <button className="selected-server" id="change-server" aria-label={t("Choose another location")} onClick={() => { app.setCollapsed(false); document.getElementById('search')?.focus(); }}>
      <span className="flag" id="selected-flag">{t(app.selected?.flag)}</span><span className="selected-server-copy"><strong id="selected-country">{t(app.selected?.country || 'Choose a location')}</strong><span id="selected-city">{t(app.selected ? `${app.selected.city} · ${app.selected.id}` : app.catalogStatus === 'loading' ? 'Loading locations…' : 'Select a server from the list')}</span></span>
    </button>
    <div className="connection-facts"><div aria-label={t("Connection time")}><span>{t("Time")}</span><strong id="session-time">{t(elapsedTime(connected ? app.snapshot!.connection.connectedAt : null, now))}</strong></div><div><span>{t("Speed · Mbps")}</span><strong id="traffic-speed" aria-label={t(measured ? `Download ${traffic!.downloadMbps!.toFixed(1)}, upload ${traffic!.uploadMbps!.toFixed(1)} megabits per second` : 'Speed unavailable')}>{t(measured ? <><span className="traffic-rate">↓{t(traffic!.downloadMbps!.toFixed(1))}</span><span className="traffic-rate">↑{t(traffic!.uploadMbps!.toFixed(1))}</span></> : '—')}</strong></div></div>
    <button id="connect-button" className="connect-button" disabled={app.cancelling || (app.pending && app.pendingAction !== 'connect') || (!connected && !blocked && !app.selected)} onClick={() => void (app.pending ? app.cancelConnect() : connected || blocked ? app.disconnect() : app.connect())}><Icon name="power" />{t(app.cancelling ? 'Cancelling' : app.pending ? 'Cancel connection' : connected ? 'Disconnect' : blocked ? 'Unblock internet' : 'Connect')}</button>
    {app.connectionError && <p role="alert">{t(app.connectionError)}</p>}
  </section>;
}
