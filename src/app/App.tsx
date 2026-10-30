import { useTranslation } from '../shared/i18n/I18n';
import { useEffect } from 'react';
import { useApp } from './AppProvider';
import { Icon } from '../shared/ui/Icon';
import { Loading } from '../shared/ui/Loading';
import { LocationsPanel } from '../features/locations/ui/LocationsPanel';
import { WorldMap } from '../features/map/ui/WorldMap';
import { Preferences } from '../features/settings/ui/Preferences';
import { AuthFlow } from '../features/auth/ui/AuthFlow';
import { Onboarding } from '../features/onboarding/ui/Onboarding';
import { DialogHost } from './DialogHost';
import logoUrl from '../../assets/stellar-vpn-logo.png';
import { compactConnectionLayout } from '../features/connection/domain/ConnectionLayout';
import { primaryViews, primaryViewForKey } from './PrimaryNavigation';
import { SubscriptionShortcut } from '../features/account/ui/SubscriptionShortcut';

export function App() {
  const t = useTranslation();
  const app = useApp();
  useEffect(() => {
    document.documentElement.classList.toggle('compact-map-layout', compactConnectionLayout);
    document.body.classList.toggle('auth-open', app.screen === 'auth');
    document.body.classList.toggle('onboarding-open', app.screen === 'onboarding');
    document.documentElement.classList.remove('auth-pending');
  }, [app.screen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !app.dialog && app.view !== 'connection') { app.setView('connection'); document.getElementById(app.view === 'account' ? 'account-tab' : 'settings-tab')?.focus(); } };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [app.dialog, app.view]);
  if (app.screen === 'booting' || app.bootError) return <main className="boot-screen" aria-live="polite"><img src={logoUrl} alt="Stellar VPN" /><p>{t(app.bootError || <Loading label={t("Opening Stellar VPN")} />)}</p>{t(app.bootError && <button onClick={() => location.reload()}>{t("Try again")}</button>)}</main>;
  if (app.screen === 'auth' && app.snapshot?.connection.trafficBlocked) return <main className="boot-screen" aria-live="polite"><img src={logoUrl} alt="Stellar VPN" /><h1>{t("Internet blocked")}</h1><p>{t("Your session expired. Kill switch is keeping traffic blocked.")}</p><button disabled={app.pending} onClick={() => void app.disconnect()}>{t("Unblock internet")}</button></main>;
  const primary = app.view === 'connection' ? 'connection' : app.view === 'account' ? 'account' : 'settings';
  return <>
    {t(app.screen === 'auth' ? <AuthFlow /> : app.screen === 'onboarding' ? <Onboarding /> : <div className="app" data-view={primary} data-connection={app.pending ? 'loading' : app.snapshot?.connection.status} data-connecting={app.pending && app.pendingAction === 'connect' && !app.cancelling}><header className="topbar"><button id="home-logo" className="logo-home" aria-label={t("Go to connection map")} onClick={() => app.setView('connection')}><img className="logo" src={logoUrl} width={500} height={128} alt="Stellar VPN" /></button><button id="locations-toggle" className="panel-toggle" aria-label={t(app.collapsed ? 'Show locations' : 'Hide locations')} aria-expanded={!app.collapsed} aria-controls="locations-panel" hidden={app.view !== 'connection'} onClick={() => app.setCollapsed(!app.collapsed)}><Icon name={app.collapsed ? 'panelShow' : 'panelHide'} /></button>
      <nav className="primary-nav" aria-label={t("Primary navigation")} data-active={primary}><span className="nav-indicator" aria-hidden="true" />{t(primaryViews.map(view => <button key={view} id={`${view}-tab`} className={view === primary ? 'active' : ''} aria-current={view === primary ? 'page' : undefined} onKeyDown={event => {
        const next = primaryViewForKey(view, event.key);
        if (!next || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        app.setView(next === 'settings' ? 'general' : next);
        document.getElementById(`${next}-tab`)?.focus({ preventScroll: true });
      }} onClick={() => app.setView(view === 'settings' ? 'general' : view)}>{t(view[0].toUpperCase() + view.slice(1))}</button>))}</nav>
      <div className="header-right" />
      {compactConnectionLayout && app.view === 'connection' && <SubscriptionShortcut />}
    </header><div className={`workspace ${app.collapsed ? 'locations-collapsed' : ''} ${app.view === 'connection' ? '' : 'preferences-open'}`} id="workspace">{t(!compactConnectionLayout && <LocationsPanel />)}<WorldMap />{t(app.view !== 'connection' && <Preferences />)}</div></div>)}
    {t(app.screen === 'app' && <DialogHost />)}
    {t(app.toast && <div id="toast" className="toast" role="status" aria-live="polite">{t(app.toast)}</div>)}
  </>;
}
