import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { GeneralSettings } from './GeneralSettings';
import { RelaySettings } from '../../relay/ui/RelaySettings';
import { AccountPage } from '../../account/ui/AccountPage';
import { DevicesPage } from '../../devices/ui/DevicesPage';
export function Preferences() {
  const t = useTranslation();
  const app = useApp(), account = app.view === 'account', devices = app.view === 'devices';
  const sections = ['general', 'relay', 'devices'] as const;
  return <main id="preferences" className="preferences"><div className="preferences-wrap"><div className="preferences-top"><div><h1 id="preferences-title">{t(account ? 'Account' : 'Settings')}</h1>{!account && <p id="preferences-description">{t(devices ? 'Devices registered to your VPN subscription.' : app.view === 'relay' ? 'Understand the privacy layers behind your connection.' : 'Manage your connection and app experience.')}</p>}</div><button id="about" className="close-preferences" aria-label={t("Close and return to connection map")} onClick={() => app.setView('connection')}><Icon name="close" /></button></div>
    {t(!account && <nav className="preferences-tabs" role="tablist" aria-label={t("Settings")} data-active={app.view}><span className="preferences-indicator" aria-hidden="true" />{t(sections.map((section, index) => <button key={section} id={`tab-${section}`} role="tab" data-section={section} className={app.view === section ? 'active' : ''} aria-selected={app.view === section} aria-controls={`section-${section}`} tabIndex={app.view === section ? 0 : -1} onClick={() => app.setView(section)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? sections[0] : event.key === 'End' ? sections[2] : sections[(index + (event.key === 'ArrowLeft' ? -1 : 1) + sections.length) % sections.length]; app.setView(next); document.getElementById(`tab-${next}`)?.focus(); } }}><span className="preference-tab-icon"><Icon name={section === 'general' ? 'settings' : section === 'devices' ? 'computer' : 'relay'} /></span><span><strong>{t(section === 'general' ? 'General' : section === 'devices' ? 'Devices' : 'Stellar Relay')}</strong><small>{t(section === 'general' ? 'App defaults' : section === 'devices' ? 'Registered devices' : 'Multi-hop')}</small></span></button>))}</nav>)}
    <div className="view-enter" key={app.view}>{t(devices ? <DevicesPage /> : account ? <AccountPage /> : app.view === 'relay' ? <RelaySettings /> : <GeneralSettings />)}</div>
  </div></main>;
}
