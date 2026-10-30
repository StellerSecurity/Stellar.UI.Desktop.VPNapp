import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Loading } from '../../../shared/ui/Loading';
import { TrayLocationPicker } from './TrayLocationPicker';
import appIcon from '../../../../assets/app-icon.png';
import { CountryFlag } from '../../../shared/ui/CountryFlag';
import { Dialog } from '../../../shared/ui/Dialog';
import { SubscriptionAccessDialog } from '../../account/ui/SubscriptionAccessDialog';

export function TrayApp() {
  const t = useTranslation();
  const app = useApp();
  const [choosingLocation, setChoosingLocation] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const locationTrigger = useRef<HTMLButtonElement>(null);
  const connected = app.snapshot?.connection.status === 'connected';
  const blocked = !!app.snapshot?.connection.trafficBlocked;
  const waiting = app.pending && app.pendingAction === 'connect';
  const authenticated = app.snapshot?.session.authenticated && app.snapshot.session.onboardingComplete;
  const current = app.servers.find(server => server.id === app.snapshot?.connection.serverId);
  const location = !app.pending && connected && current ? current : app.selected;
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) void app.hideTray(); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);
  return <main className="tray-app" aria-label={t("Stellar VPN quick controls")}>
    <header className="tray-header"><div className="tray-brand"><img src={appIcon} alt="" width={24} height={24} /><strong>{t("Stellar VPN")}</strong></div>
      <span className={`tray-status ${connected && !app.pending ? 'is-connected' : ''}`} role="status"><Icon name={connected && !app.pending ? 'shield' : 'globe'} />{t(app.cancelling ? 'Cancelling' : app.pending ? app.pendingAction === 'connect' ? 'Connecting' : 'Disconnecting' : connected ? 'Protected' : blocked ? 'Internet blocked' : 'Not connected')}</span>
    </header>
    <div className="tray-actions">
      <button ref={locationTrigger} className="tray-location" aria-label={t('Change location')} aria-haspopup="dialog" aria-expanded={choosingLocation} disabled={app.pending || app.screen === 'booting'} onClick={() => { if (!authenticated) { void app.showMain(); return; } setChoosingLocation(true); }}>
        {location ? <CountryFlag code={location.countryCode} className="tray-selected-flag" /> : <Icon name="globe" />}
        <span className="tray-location-copy"><small>{t(connected && !app.pending ? 'Connected location' : 'Selected location')}</small><strong>{t(location?.country || 'Choose a location')}</strong>{location && <span>{location.city}</span>}</span><Icon name="chevron" />
      </button>
      <button className={`tray-connect ${connected || blocked ? 'disconnect' : ''}`} disabled={app.cancelling || (app.pending && !waiting) || app.screen === 'booting' || !!app.bootError} onClick={() => { if (waiting) { void app.cancelConnect(); return; } if (blocked) { void app.disconnect(); return; } if (!authenticated) { void app.showMain(); return; } void (connected ? app.disconnect() : app.connect()); }}>
      {t(app.cancelling ? <Loading label={t('Cancelling')} /> : waiting ? 'Cancel connection' : app.pending ? <Loading label={t("Loading")} /> : <><Icon name="power" />{t(blocked ? 'Unblock internet' : !authenticated ? 'Log in' : connected ? 'Disconnect' : 'Connect')}</>)}
    </button></div>
    {t((app.connectionError || app.toast || app.bootError) && <p className="tray-error" role="status">{t(app.connectionError || app.toast || app.bootError)}</p>)}
    <footer className="tray-footer"><button onClick={() => setConfirmQuit(true)}>{t("Quit")}</button><button onClick={() => void app.showMain()}>{t("Open Stellar VPN")}<span aria-hidden="true">↗</span></button></footer>
    {confirmQuit && <Dialog id="tray-quit" title={t('Quit Stellar VPN?')} className="tray-quit-dialog" onClose={() => setConfirmQuit(false)}>
      <p>{t(connected || blocked || app.pending ? 'Quitting stops the VPN and releases the kill switch. Your internet traffic will no longer be protected by Stellar VPN.' : 'Are you sure you want to quit Stellar VPN?')}</p>
      <div className="tray-quit-actions"><button data-dialog-initial-focus type="button" className="close-dialog-text" disabled={quitting}>{t('Cancel')}</button><button type="button" className="tray-confirm-quit" disabled={quitting} onClick={() => { setQuitting(true); void app.quit()?.catch(() => { setQuitting(false); app.notify('The action could not be completed. Please try again.'); }); }}>{t(quitting ? 'Please wait…' : 'Quit')}</button></div>
    </Dialog>}
    {app.dialog === 'subscription' && <SubscriptionAccessDialog compact />}
    {t(choosingLocation && <TrayLocationPicker servers={app.servers} selectedId={app.selectedId} busy={app.pending} onSelect={id => app.activateMarker(id)} onClose={() => { setChoosingLocation(false); locationTrigger.current?.focus(); }} />)}
  </main>;
}
