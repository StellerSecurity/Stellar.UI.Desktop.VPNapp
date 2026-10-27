import { ExternalLink } from '../../../shared/ui/ExternalLink';
import { Icon } from '../../../shared/ui/Icon';
export function RelaySettings() { return (<section id="section-relay" className="preference-section" role="tabpanel" aria-labelledby="tab-relay">
            <div className="settings-card relay-card">
              <div className="relay-header">
                <span className="relay-mark" aria-hidden="true"><Icon name="relay" /></span>
                <div><span className="eyebrow">ADVANCED PRIVACY</span><h2>Stellar Relay</h2><p>Your traffic enters through a privacy-focused core before reaching your selected exit country.</p></div>
                <div className="relay-control relay-locked"><span className="status-with-dot"><i></i>Always on</span><small>Required protection</small></div>
              </div>

              <div className="relay-route" aria-label="Relay route: your device, privacy core, exit country, internet">
                <div className="relay-node"><span>1</span><strong>Your device</strong><small>Encrypted</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node relay-core"><span>2</span><strong>Privacy core</strong><small>🇮🇸 🇨🇭 🇸🇪</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node"><span>3</span><strong>Exit country</strong><small>Your choice</small></div>
                <i aria-hidden="true"></i>
                <div className="relay-node"><span>4</span><strong>Internet</strong><small>Origin hidden</small></div>
              </div>

              <div className="relay-explainer">
                <div><strong>Two-hop privacy</strong><p>The exit sees the Relay edge instead of your device or original IP address.</p></div>
                <div><strong>Hardened core</strong><p>Core routes use privacy-focused infrastructure in Iceland, Switzerland and Sweden.</p></div>
                <div><strong>Smart routing</strong><p>Stellar selects a route that balances connection quality with the added privacy layer.</p></div>
              </div>

              <ExternalLink className="relay-learn" href="https://stellarvpn.org/stellar-relay"><span>How Stellar Relay works</span><i>↗</i></ExternalLink>
            </div>
          </section>); }
