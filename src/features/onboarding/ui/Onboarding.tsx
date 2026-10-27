import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon, type IconName } from '../../../shared/ui/Icon';
import logoUrl from '../../../../assets/stellar-vpn-logo.png';
const pages: { mode: string; eyebrow: string; title: string; body: string; features: [IconName, string][] }[] = [
  { mode: 'trust', eyebrow: 'Privacy by design', title: 'Privacy that starts with trust.', body: 'Stellar VPN is built around Swiss privacy principles. Your traffic is encrypted, and your activity is never logged.', features: [['building', 'Based in Switzerland'], ['noLogs', 'No activity logs'], ['shield', 'Encrypted by default']] },
  { mode: 'protection', eyebrow: 'Always protected', title: 'Secure wherever you connect.', body: 'Protect public Wi-Fi, travel, and everyday browsing with one clear connection state.', features: [['wifi', 'One-tap protection'], ['shield', 'Kill switch ready'], ['globe', 'Worldwide locations']] },
  { mode: 'premium', eyebrow: 'Your privacy, your way', title: 'Choose how you stay private.', body: 'Use Stellar Relay for multi-hop routing and Auto Rotate to refresh your route automatically.', features: [['relay', 'Stellar Relay'], ['rotate', 'Auto Rotate'], ['shield', 'Kill switch']] }
];
function Visual({ mode }: { mode: string }) {
  return <div className={`onboarding-visual ${mode}-visual`} aria-hidden="true">
    {mode === 'trust' ? <><div className="privacy-emblem"><Icon name="shield" /></div><div className="guide-heading"><span>BUILT AROUND YOUR PRIVACY</span><strong>Your activity stays yours.</strong></div><div className="privacy-facts"><div><Icon name="building" /><span>Swiss-based</span></div><div><Icon name="noLogs" /><span>No activity logs</span></div></div></>
    : mode === 'protection' ? <><div className="privacy-emblem"><Icon name="globe" /></div><div className="guide-heading"><span>WHEREVER YOU GO</span><strong>Your connection, protected.</strong></div><div className="guide-connection"><span className="guide-status-icon"><Icon name="shield" /></span><div><span>CONNECTION</span><strong>Connected</strong><small>Copenhagen, Denmark</small></div><span className="guide-secure">Secure</span></div></>
    : <><div className="guide-heading"><span>STELLAR RELAY</span><strong>One connection. Two privacy layers.</strong></div><div className="guide-route"><div><Icon name="computer" /><span>Your device</span></div><i>→</i><div><Icon name="shield" /><span>Privacy core</span></div><i>→</i><div><Icon name="globe" /><span>Exit location</span></div></div><div className="guide-controls"><div><Icon name="relay" /><span>Stellar Relay</span><small>Always on</small></div><div><Icon name="rotate" /><span>Auto Rotate</span><small>Your choice</small></div><div><Icon name="shield" /><span>Kill switch</span><small>Your choice</small></div></div></>}
  </div>;
}
export function Onboarding() {
  const app = useApp(), [index, setIndex] = useState(0), [direction, setDirection] = useState('right');
  const touch = useRef<number | null>(null), next = useRef<HTMLButtonElement>(null);
  useEffect(() => { next.current?.focus({ preventScroll: true }); }, []);
  function change(value: number) { if (value < 0 || value >= pages.length) return; setDirection(value < index ? 'left' : 'right'); setIndex(value); }
  const page = pages[index];
  return <section id="onboarding" className="onboarding" aria-label="Welcome to Stellar VPN"><div className="onboarding-shell"><header className="onboarding-header"><img src={logoUrl} width={500} height={128} alt="Stellar VPN" /><div className="onboarding-progress" aria-label={`Onboarding progress: step ${index + 1} of 3`}>{pages.map((_, i) => <span key={i} className={i === index ? 'active' : ''} />)}</div><button className="onboarding-skip" hidden={index === 2} onClick={() => void app.finishOnboarding()}>Skip</button></header>
    <div className="onboarding-stage" aria-live="polite" onPointerDown={event => { if (event.pointerType === 'touch') touch.current = event.clientX; }} onPointerUp={event => { if (touch.current !== null) { const delta = event.clientX - touch.current; if (Math.abs(delta) > 60) change(index + (delta < 0 ? 1 : -1)); touch.current = null; } }} onPointerCancel={() => { touch.current = null; }}><article key={index} className={`onboarding-page onboarding-page-${page.mode} from-${direction}`}><div className="onboarding-copy"><span className="onboarding-badge"><Icon name={page.mode === 'trust' ? 'shield' : page.mode === 'protection' ? 'wifi' : 'settings'} />{page.eyebrow}</span><h1>{page.title}</h1><p>{page.body}</p><div className="onboarding-features">{page.features.map(([icon, label]) => <div key={label}><span><Icon name={icon} /></span><strong>{label}</strong></div>)}</div></div><Visual mode={page.mode} /></article></div>
    <footer className="onboarding-footer"><span>{index + 1} of 3</span><div className="onboarding-actions"><button className="onboarding-back" hidden={index === 0} onClick={() => change(index - 1)}>Back</button><button ref={next} className="onboarding-next" onClick={() => { if (index === 2) void app.finishOnboarding(); else change(index + 1); }}>{index === 2 ? 'Start with Stellar VPN' : 'Continue'}</button></div></footer>
  </div></section>;
}
