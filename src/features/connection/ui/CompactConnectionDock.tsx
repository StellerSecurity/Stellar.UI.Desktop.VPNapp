import { useLocale, useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { CountryFlag } from '../../../shared/ui/CountryFlag';
import { Icon } from '../../../shared/ui/Icon';
import { elapsedTime } from '../domain/Connection';
import { DesktopLocationPopover } from '../../locations/ui/DesktopLocationPopover';
import { PendingText } from '../../../shared/ui/PendingText';
import { connectionTraffic, displayTrafficRate, emptyTraffic } from '../domain/ConnectionTraffic';

export function CompactConnectionDock() {
  const t = useTranslation();
  const locale = useLocale();
  const app = useApp();
  const trigger = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const connection = app.snapshot?.connection;
  const lastTraffic = useRef(emptyTraffic);
  const traffic = connectionTraffic(lastTraffic.current, app.pending && app.pendingAction === 'connect' ? undefined : connection);
  lastTraffic.current = traffic;
  const connected = connection?.status === 'connected';
  const blocked = !!connection?.trafficBlocked;
  const open = !app.collapsed && app.view === 'connection';
  const pendingLabel = app.cancelling ? 'Cancelling' : app.pendingAction === 'disconnect' ? 'Disconnecting' : 'Connecting';
  const waiting = app.pendingAction === 'connect' && app.pending;
  const seconds = app.pendingSince ? Math.max(0, Math.floor((now - app.pendingSince) / 1000)) : 0;
  const status = app.pending ? <PendingText label={t(pendingLabel)} />
    : connected ? 'Connected location' : blocked ? 'Internet blocked' : 'Selected location';
  return <section className="compact-connection-dock" aria-label={t("VPN connection controls")} aria-busy={app.pending}>
    <button ref={trigger} id="change-server" type="button" className="dock-location-trigger" aria-label={t(open ? 'Close server list' : 'Choose a server')}
      aria-haspopup="dialog" aria-expanded={open} aria-controls="desktop-location-popover" onClick={() => app.setCollapsed(!app.collapsed)}>
      {t(app.selected ? <CountryFlag code={app.selected.countryCode} className="dock-country-flag" /> : <span className="dock-globe"><Icon name="globe" /></span>)}
      <span className="dock-location-copy"><span className="dock-location-status" role="status" aria-live="polite">{t(status)}</span>
        <span className="dock-location-name"><strong>{t(app.selected?.country || 'Choose a location')}</strong>{t(app.selected && <span>{t(app.selected.city)}</span>)}</span>
      </span><span className="dock-location-chevron" data-open={open} aria-hidden="true"><span className="dock-location-glyph dock-location-glyph-chevron"><Icon name="chevron" /></span><span className="dock-location-glyph dock-location-glyph-close"><Icon name="close" /></span></span>
    </button>
    <button id="connect-button" className="dock-connect-button" data-action={connected ? 'disconnect' : blocked ? 'unblock' : 'connect'} type="button" disabled={app.cancelling || (app.pending && !waiting) || (!connected && !blocked && !app.selected)}
      onClick={() => void (waiting ? app.cancelConnect() : connected || blocked ? app.disconnect() : app.connect())}>
      {t(!app.pending && <Icon name="power" />)}<span>{t(app.cancelling ? <PendingText label={t('Cancelling')} /> : waiting ? 'Cancel connection' : app.pending ? <PendingText label={t(pendingLabel)} /> : connected ? 'Disconnect' : blocked ? 'Unblock internet' : 'Connect')}</span>
    </button>
    <div className="dock-connection-details" aria-label={t("Connection details")}>
      <Icon name={connected ? 'shield' : 'globe'} />
      {t(connected && !app.pending ? <><span>{t(elapsedTime(connection.connectedAt, now))}</span><span aria-hidden="true">·</span><span className="dock-traffic-rates" aria-label={`${t('Download')} ${displayTrafficRate(traffic.download, locale)}, ${t('Upload')} ${displayTrafficRate(traffic.upload, locale)} Mbps`}>{`↓ ${displayTrafficRate(traffic.download, locale)}  ↑ ${displayTrafficRate(traffic.upload, locale)} Mbps`}</span></>
        : <span>{t(app.pending ? app.cancelling ? 'Waiting for confirmation that the connection has stopped' : app.pendingAction === 'disconnect' ? 'Closing your connection' : seconds >= 30 ? 'Stopping timed-out connection' : seconds >= 10 ? 'Taking longer than usual' : 'Establishing your connection' : blocked ? 'Kill switch is blocking traffic' : 'Choose a location to get started')}{waiting && !app.cancelling ? ` · ${seconds} s` : ''}</span>)}
    </div>
    {app.connectionError && <div className="dock-connection-error" role="alert"><span>{t(app.connectionError)}</span>{!app.pending && <div className="dock-error-actions">{app.connectionErrorKind === 'subscription' ? <><button className="dock-error-primary" type="button" onClick={() => app.setView('account')}>{t('View your subscription')}</button><button className="dock-error-secondary" type="button" onClick={() => app.setDialog('activation')}>{t('Use activation code')}</button></> : <><button className="dock-error-primary" type="button" onClick={() => void app.connect()}>{t('Try again')}</button><button className="dock-error-secondary" type="button" onClick={() => app.setCollapsed(false)}>{t('Choose another location')}</button></>}</div>}</div>}
    <DesktopLocationPopover open={open} trigger={trigger} onClose={() => app.setCollapsed(true)} />
  </section>;
}
