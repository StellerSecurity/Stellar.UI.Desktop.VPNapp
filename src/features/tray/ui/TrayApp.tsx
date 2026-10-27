import { useEffect } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Loading } from '../../../shared/ui/Loading';

export function TrayApp() {
  const app = useApp();
  const connected = app.snapshot?.connection.status === 'connected';
  const authenticated = app.snapshot?.session.authenticated && app.snapshot.session.onboardingComplete;
  const current = app.servers.find(server => server.id === app.snapshot?.connection.serverId);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') void app.hideTray(); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);
  return <main className="tray-app" aria-label="Stellar VPN quick controls">
    <header className="tray-header"><strong>Stellar VPN</strong><span>UI preview</span></header>
    <section className="tray-summary" aria-live="polite">
      <span className={`tray-status-icon ${connected ? 'is-connected' : ''}`}><Icon name="shield" /></span>
      <div><h1>{connected ? 'Connected' : 'Not connected'}</h1><p>{connected && current ? `${current.flag} ${current.country} · ${current.city}` : app.selected ? `${app.selected.flag} ${app.selected.country} · ${app.selected.city}` : 'Ready when you are'}</p></div>
    </section>
    <div className="tray-actions"><button className={`tray-connect ${connected ? 'disconnect' : ''}`} disabled={app.pending || app.screen === 'booting' || !!app.bootError} onClick={() => { if (!authenticated) { void app.showMain(); return; } void (connected ? app.disconnect() : app.connect()); }}>
      {app.pending ? <Loading label="Loading" /> : <><Icon name="power" />{!authenticated ? 'Log in' : connected ? 'Disconnect' : 'Connect'}</>}
    </button><button className="tray-location" onClick={() => void app.showLocations()}><Icon name="globe" />Change location<Icon name="right" /></button></div>
    {(app.toast || app.bootError) && <p className="tray-error" role="status">{app.toast || app.bootError}</p>}
    <footer className="tray-footer"><button onClick={() => void app.quit()}>Quit</button><button onClick={() => void app.showMain()}>Open Stellar VPN <span aria-hidden="true">↗</span></button></footer>
  </main>;
}
