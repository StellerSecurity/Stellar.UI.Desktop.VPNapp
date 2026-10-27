import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Toggle } from './Toggle';
import { LanguageSelector } from './LanguageSelector';
export function GeneralSettings() { const app = useApp(); return (<section id="section-general" className="preference-section" role="tabpanel" aria-labelledby="tab-general">
            <div className="settings-stack">
              <div className="settings-card">
                <div className="section-intro"><span className="feature-icon"><Icon name="shield" /></span><div><h2>Connection & privacy</h2><p>Protection that follows you automatically.</p></div></div>
                <div className="setting-row">
                  <div><strong>Auto-connect</strong><p>Connect to your last location when Stellar VPN opens.</p></div>
                  <Toggle name="auto-connect" label="Auto-connect" />
                </div>
                <div className="setting-row">
                  <div><strong>Kill switch</strong><p>Block internet access if the secure connection drops.</p></div>
                  <Toggle name="kill-switch" label="Kill switch" />
                </div>
                <div className="setting-row setting-row-featured">
                  <span className="row-icon" aria-hidden="true"><Icon name="rotate" /></span>
                  <div><span className="setting-title-line"><strong>Auto Rotate</strong><span className="feature-badge">Every 7 days</span></span><p>Move to the next location automatically for better privacy.</p><small id="rotation-status" className="setting-meta">{app.snapshot?.settings.autoRotate ? 'Next rotation in 7 days' : 'Enable to rotate every 7 days'}</small></div>
                  <div className="setting-controls"><button id="auto-rotate-info" onClick={() => app.setDialog('auto-rotate')} className="info-button" aria-label="How Auto Rotate works" aria-haspopup="dialog"><Icon name="info" /></button><Toggle name="auto-rotate" label="Auto Rotate" /></div>
                </div>
              </div>

              <div className="settings-card compact-card">
                <div className="section-label">APP EXPERIENCE</div>
                <div className="setting-row"><div><strong>Connection notifications</strong><p>Get notified when your protection changes.</p></div><Toggle name="notifications" label="Connection notifications" /></div>
                <div className="setting-row"><div><strong>Menu bar controls</strong><p>Keep quick Connect and Disconnect close at hand.</p></div><Toggle name="menu-bar" label="Menu bar controls" /></div>
                <div className="setting-row language-row">
                  <div><strong>Language</strong><p>Language used throughout the app.</p></div>
                  <LanguageSelector />
                </div>
                <button id="replay-onboarding" onClick={() => app.setScreen('onboarding')} className="setting-row setting-action onboarding-replay">
                  <span className="row-icon"><Icon name="sparkles" /></span>
                  <span><strong>Welcome guide</strong><small>Get to know your privacy features.</small></span>
                  <i className="action-arrow">›</i>
                </button>
              </div>
            </div>
          </section>); }
