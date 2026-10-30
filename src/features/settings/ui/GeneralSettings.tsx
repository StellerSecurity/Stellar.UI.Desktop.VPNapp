import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Toggle } from './Toggle';
import { LanguageSelector } from './LanguageSelector';
import { UpdateControl } from '../../updates/ui/UpdateControl';
export function GeneralSettings() {
  const t = useTranslation(); const app = useApp(); return (<section id="section-general" className="preference-section" role="tabpanel" aria-labelledby="tab-general">
            <div className="settings-stack">
              <div className="settings-card">
                <div className="section-intro"><span className="feature-icon"><Icon name="shield" /></span><div><h2>{t("Connection & privacy")}</h2><p>{t("Protection that follows you automatically.")}</p></div></div>
                <div className="setting-row">
                  <div><strong>{t("Auto-connect")}</strong><p>{t("Start at computer login and connect to your last location.")}</p></div>
                  <Toggle name="auto-connect" label={t("Auto-connect")} />
                </div>
                <div className="setting-row">
                  <div><strong>{t("Kill switch")}</strong><p>{t(app.snapshot?.capabilities?.killSwitch ? 'Block traffic if the tunnel drops. Disconnect before changing this.' : 'System verification required.')}</p></div>
                  <Toggle name="kill-switch" label={t("Kill switch")} disabled={!app.snapshot?.capabilities?.killSwitch} />
                </div>
                <div className="setting-row">
                  <div><strong>{t("Auto Rotate")}</strong><p>{t("Change location every 7 days while connected.")}</p></div>
                  <Toggle name="auto-rotate" label={t("Auto Rotate")} disabled={!app.snapshot?.capabilities?.autoRotate} />
                </div>
              </div>

              <div className="settings-card compact-card">
                <div className="section-label">{t("APP EXPERIENCE")}</div>
                <div className="setting-row"><div><strong>{t("Notifications")}</strong><p>{t("Connection changes and verified software updates.")}</p></div><Toggle name="notifications" label={t("Notifications")} /></div>
                <div className="setting-row language-row">
                  <div><strong>{t("Language")}</strong><p>{t("Language used throughout the app.")}</p></div>
                  <LanguageSelector />
                </div>
                <button id="replay-onboarding" onClick={() => app.setScreen('onboarding')} className="setting-row setting-action onboarding-replay">
                  <span className="row-icon"><Icon name="sparkles" /></span>
                  <span><strong>{t("Welcome guide")}</strong><small>{t("Get to know your privacy features.")}</small></span>
                  <i className="action-arrow">›</i>
                </button>
              </div>
              <UpdateControl />
            </div>
          </section>); }
