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

export function App() {
  const app = useApp();
  useEffect(() => {
    document.body.classList.toggle('auth-open', app.screen === 'auth');
    document.body.classList.toggle('onboarding-open', app.screen === 'onboarding');
    document.documentElement.classList.remove('auth-pending');
  }, [app.screen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !app.dialog && app.view !== 'connection') { app.setView('connection'); document.getElementById(app.view === 'account' ? 'account-tab' : 'settings-tab')?.focus(); } };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [app.dialog, app.view]);
  if (app.screen === 'booting' || app.bootError) return <main className="boot-screen" aria-live="polite"><img src={logoUrl} alt="Stellar VPN" /><p>{app.bootError || <Loading label="Opening Stellar VPN" />}</p>{app.bootError && <button onClick={() => location.reload()}>Try again</button>}</main>;
  const primary = app.view === 'connection' ? 'connection' : app.view === 'account' ? 'account' : 'settings';
  return <>
    {app.screen === 'auth' ? <AuthFlow /> : app.screen === 'onboarding' ? <Onboarding /> : <div className="app" data-connection={app.pending ? 'loading' : app.snapshot?.connection.status}><header className="topbar"><button id="home-logo" className="logo-home" aria-label="Go to connection map" onClick={() => app.setView('connection')}><img className="logo" src={logoUrl} width={500} height={128} alt="Stellar VPN" /></button><button id="locations-toggle" className="panel-toggle" aria-label={app.collapsed ? 'Show locations' : 'Hide locations'} aria-expanded={!app.collapsed} aria-controls="locations-panel" hidden={app.view !== 'connection'} onClick={() => app.setCollapsed(!app.collapsed)}><Icon name={app.collapsed ? 'panelShow' : 'panelHide'} /></button>
      <nav className="primary-nav" aria-label="Primary navigation" data-active={primary}><span className="nav-indicator" aria-hidden="true" />{(['connection', 'settings', 'account'] as const).map(view => <button key={view} id={`${view}-tab`} className={view === primary ? 'active' : ''} aria-current={view === primary ? 'page' : undefined} onClick={() => app.setView(view === 'settings' ? 'general' : view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</nav>
      <div className="header-right"><span className="preview-badge" title="This build simulates VPN connections. It does not route or protect your traffic.">UI preview · VPN inactive</span>{app.view !== 'connection' && <button id="about" className="header-icon close-preferences" aria-label="Close settings and return to connection map" onClick={() => app.setView('connection')}><Icon name="close" /></button>}</div>
    </header><div className={`workspace ${app.collapsed ? 'locations-collapsed' : ''} ${app.view === 'connection' ? '' : 'preferences-open'}`} id="workspace"><LocationsPanel /><WorldMap />{app.view !== 'connection' && <Preferences />}</div></div>}
    {app.screen === 'app' && <DialogHost />}
    {app.toast && <div id="toast" className="toast" role="status" aria-live="polite">{app.toast}</div>}
  </>;
}
