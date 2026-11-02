import { useTranslation } from '../../../shared/i18n/I18n';
import { ExternalLink } from '../../../shared/ui/ExternalLink';
import { Icon } from '../../../shared/ui/Icon';
export function RelaySettings() {
  const t = useTranslation(); return (<section id="section-relay" className="preference-section" role="tabpanel" aria-labelledby="tab-relay">
            <div className="settings-card relay-card">
              <div className="relay-header">
                <span className="relay-mark" aria-hidden="true"><Icon name="relay" /></span>
                <div><span className="eyebrow">{t("ADVANCED PRIVACY")}</span><h2>{t("Stellar Relay")}</h2><p>{t("Your traffic enters through a privacy-focused core before reaching your selected exit country.")}</p></div>
                <div className="relay-control relay-locked"><span className="status-with-dot"><i></i>{t("Always on")}</span><small>{t("Required protection")}</small></div>
              </div>

              <div className="relay-route" aria-label={t("Relay route: your device, privacy core, exit country, internet")}>
                <div className="relay-node"><span>1</span><strong>{t("Your device")}</strong><small>{t("Encrypted")}</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node relay-core"><span>2</span><strong>{t("Privacy core")}</strong><small>🇮🇸 🇨🇭 🇸🇪</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node"><span>3</span><strong>{t("Exit country")}</strong><small>{t("Your choice")}</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node"><span>4</span><strong>{t("Internet")}</strong><small>{t("Origin hidden")}</small></div>
              </div>

              <div className="relay-explainer">
                <div><strong>{t("Two-hop privacy")}</strong><p>{t("The exit sees the Relay edge instead of your device or original IP address.")}</p></div>
                <div><strong>{t("Hardened core")}</strong><p>{t("Core routes use privacy-focused infrastructure in Iceland, Switzerland and Sweden.")}</p></div>
                <div><strong>{t("Smart routing")}</strong><p>{t("Stellar selects a route that balances connection quality with the added privacy layer.")}</p></div>
              </div>

              <ExternalLink className="relay-learn" href="https://stellarvpn.org/stellar-relay"><span>{t("How Stellar Relay works")}</span><i>↗</i></ExternalLink>
            </div>
          </section>); }
