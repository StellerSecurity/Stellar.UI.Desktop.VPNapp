import { useTranslation } from '../../../shared/i18n/I18n';
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
  const t = useTranslation();
  return <div className={`onboarding-visual ${mode}-visual`} aria-hidden="true">
    {t(mode === 'trust' ? <><div className="privacy-emblem"><Icon name="shield" /></div><div className="guide-heading"><span>{t("BUILT AROUND YOUR PRIVACY")}</span><strong>{t("Your activity stays yours.")}</strong></div><div className="privacy-facts"><div><Icon name="building" /><span>{t("Swiss-based")}</span></div><div><Icon name="noLogs" /><span>{t("No activity logs")}</span></div></div></>
    : mode === 'protection' ? <><div className="privacy-emblem"><Icon name="globe" /></div><div className="guide-heading"><span>{t("WHEREVER YOU GO")}</span><strong>{t("Your connection, protected.")}</strong></div><div className="guide-connection"><span className="guide-status-icon"><Icon name="shield" /></span><div><span>{t("CONNECTION")}</span><strong>{t("Connected")}</strong><small>{t("Copenhagen, Denmark")}</small></div><span className="guide-secure">{t("Secure")}</span></div></>
    : <><div className="guide-heading"><span>{t("STELLAR RELAY")}</span><strong>{t("One connection. Two privacy layers.")}</strong></div><div className="guide-route"><div><Icon name="computer" /><span>{t("Your device")}</span></div><i>→</i><div><Icon name="shield" /><span>{t("Privacy core")}</span></div><i>→</i><div><Icon name="globe" /><span>{t("Exit location")}</span></div></div><div className="guide-controls"><div><Icon name="relay" /><span>{t("Stellar Relay")}</span><small>{t("Always on")}</small></div><div><Icon name="rotate" /><span>{t("Auto Rotate")}</span><small>{t("Your choice")}</small></div><div><Icon name="shield" /><span>{t("Kill switch")}</span><small>{t("Your choice")}</small></div></div></>)}
  </div>;
}
export function Onboarding() {
  const t = useTranslation();
  const app = useApp(), [index, setIndex] = useState(0), [direction, setDirection] = useState('right');
  const touch = useRef<number | null>(null), next = useRef<HTMLButtonElement>(null);
  useEffect(() => { next.current?.focus({ preventScroll: true }); }, []);
  function change(value: number) { if (value < 0 || value >= pages.length) return; setDirection(value < index ? 'left' : 'right'); setIndex(value); }
  const page = pages[index];
  return <section id="onboarding" className="onboarding" aria-label={t("Welcome to Stellar VPN")}><div className="onboarding-shell"><header className="onboarding-header"><img src={logoUrl} width={500} height={128} alt="Stellar VPN" /><div className="onboarding-progress" aria-label={t(`Onboarding progress: step ${index + 1} of 3`)}>{t(pages.map((_, i) => <span key={i} className={i === index ? 'active' : ''} />))}</div><button className="onboarding-skip" hidden={index === 2} onClick={() => void app.finishOnboarding()}>{t("Skip")}</button></header>
    <div className="onboarding-stage" aria-live="polite" onPointerDown={event => { if (event.pointerType === 'touch') touch.current = event.clientX; }} onPointerUp={event => { if (touch.current !== null) { const delta = event.clientX - touch.current; if (Math.abs(delta) > 60) change(index + (delta < 0 ? 1 : -1)); touch.current = null; } }} onPointerCancel={() => { touch.current = null; }}><article key={index} className={`onboarding-page onboarding-page-${page.mode} from-${direction}`}><div className="onboarding-copy"><span className="onboarding-badge"><Icon name={page.mode === 'trust' ? 'shield' : page.mode === 'protection' ? 'wifi' : 'settings'} />{t(page.eyebrow)}</span><h1>{t(page.title)}</h1><p>{t(page.body)}</p><div className="onboarding-features">{t(page.features.map(([icon, label]) => <div key={label}><span><Icon name={icon} /></span><strong>{t(label)}</strong></div>))}</div></div><Visual mode={page.mode} /></article></div>
    <footer className="onboarding-footer"><span>{t(index + 1)} {t("of 3")}</span><div className="onboarding-actions"><button className="onboarding-back" hidden={index === 0} onClick={() => change(index - 1)}>{t("Back")}</button><button ref={next} className="onboarding-next" onClick={() => { if (index === 2) void app.finishOnboarding(); else change(index + 1); }}>{t(index === 2 ? 'Start with Stellar VPN' : 'Continue')}</button></div></footer>
  </div></section>;
}
