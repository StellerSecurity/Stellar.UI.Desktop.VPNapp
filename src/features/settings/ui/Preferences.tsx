import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { GeneralSettings } from './GeneralSettings';
import { RelaySettings } from '../../relay/ui/RelaySettings';
import { AccountPage } from '../../account/ui/AccountPage';
export function Preferences() {
  const app = useApp(), account = app.view === 'account';
  return <main id="preferences" className="preferences"><div className="preferences-wrap"><div className="preferences-top"><div><span className="eyebrow">STELLAR VPN</span><h1 id="preferences-title">{account ? 'Account' : 'Settings'}</h1><p id="preferences-description">{account ? 'View your account and this device.' : app.view === 'relay' ? 'Understand the privacy layers behind your connection.' : 'Manage your connection and app experience.'}</p></div></div>
    {!account && <nav className="preferences-tabs" role="tablist" aria-label="Settings" data-active={app.view}><span className="preferences-indicator" aria-hidden="true" />{(['general', 'relay'] as const).map(section => <button key={section} id={`tab-${section}`} role="tab" data-section={section} className={app.view === section ? 'active' : ''} aria-selected={app.view === section} aria-controls={`section-${section}`} tabIndex={app.view === section ? 0 : -1} onClick={() => app.setView(section)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'general' : event.key === 'End' ? 'relay' : section === 'general' ? 'relay' : 'general'; app.setView(next); document.getElementById(`tab-${next}`)?.focus(); } }}><span className="preference-tab-icon"><Icon name={section === 'general' ? 'settings' : 'relay'} /></span><span><strong>{section === 'general' ? 'General' : 'Stellar Relay'}</strong><small>{section === 'general' ? 'App defaults' : 'Multi-hop'}</small></span></button>)}</nav>}
    <div className="view-enter" key={app.view}>{account ? <AccountPage /> : app.view === 'relay' ? <RelaySettings /> : <GeneralSettings />}</div>
  </div></main>;
}
