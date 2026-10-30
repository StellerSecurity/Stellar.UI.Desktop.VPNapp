import { useTranslation } from '../../../shared/i18n/I18n';
import { ExternalLink } from '../../../shared/ui/ExternalLink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../../app/AppProvider';
import { accountDigits, validateAuth, type AuthView } from '../domain/Auth';
import { Icon } from '../../../shared/ui/Icon';
import appIcon from '../../../../assets/app-icon.png';
import { CountryFlag } from '../../../shared/ui/CountryFlag';
import { geometryToPath, type WorldMap } from '../../map/domain/geometry';
import './auth-wholesale.css';
const names: Record<AuthView, string> = { intro: 'Welcome', login: 'Log in', register: 'Create a Stellar ID', account: 'Account number' };
const parents: Partial<Record<AuthView, AuthView>> = { login: 'intro', register: 'intro', account: 'intro' };
function Heading({ title, children }: { kicker: string; title: string; children: ReactNode }) {
  const t = useTranslation();
  return <div className="auth-view-header"><h1>{t(title)}</h1><p>{t(children)}</p></div>;
}
function PasswordField({ label, name, registration = false }: { label: string; name: string; registration?: boolean }) {
  const t = useTranslation();
  const [visible, setVisible] = useState(false);
  return <label className="auth-field"><span>{t(label)}</span><div className="auth-input-wrap"><input name={name} type={visible ? 'text' : 'password'} autoComplete={registration ? 'new-password' : 'current-password'} placeholder={t(registration ? 'At least 6 characters' : 'Enter your password')} /><button className="auth-password-toggle" type="button" aria-label={t(`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`)} aria-pressed={visible} onClick={() => setVisible(!visible)}><Icon name="eye" /></button></div></label>;
}
function SignupOptions({ onRegister }: { onRegister: () => void }) {
  const t = useTranslation();
  return <p className="auth-switch">{t("Don’t have a Stellar ID?")} <button type="button" onClick={onRegister}>{t("Create a Stellar ID")}</button> {t("or")} <ExternalLink href="https://stellarvpn.org/register">{t("Create an anonymous account number")}</ExternalLink>.</p>;
}
export function AuthFlow() {
  const t = useTranslation();
  const app = useApp();
  const [view, setView] = useState<AuthView>('intro'), [email, setEmail] = useState(''), [accountNumber, setAccountNumber] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { stage.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true }); }, [view]);
  function navigate(next: AuthView) { setError(''); setView(next); }
  async function authenticate(operation: 'login' | 'register' | 'account', email: string, password: string) {
    setBusy(true);
    try { await app.authenticate(operation, email, password); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not log in. Please try again.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    const message = validateAuth(view, data);
    if (message) { setError(message); return; }
    setError('');
    if (data.email) setEmail(data.email);
    if (view === 'account') {
      const number = accountDigits(data.account);
      setAccountNumber('');
      await authenticate('account', number, '');
      return;
    }
    if (view !== 'login' && view !== 'register') return;
    const password = data.password;
    event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="password"], input[name="password"]').forEach(input => { input.value = ''; });
    delete data.password;
    await authenticate(view, data.email, password);
  }
  const emailField = <label className="auth-field"><span>{t("Email")}</span><input name="email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder={t("you@example.com")} /></label>;
  return <section id="auth-flow" className="auth-flow auth-wholesale" aria-label={t("Sign in to Stellar VPN")} onKeyDown={event => {
    if (event.key === 'Escape' && !busy && parents[view]) { event.preventDefault(); event.stopPropagation(); navigate(parents[view]!); }
  }}><div className="auth-shell"><aside className="auth-brand" aria-hidden="true"><AuthWorldBackdrop /><div className="auth-brand-copy"><span className="auth-swiss-badge"><CountryFlag code="CH" className="auth-swiss-flag" />{t("SWISS PRIVACY")}</span><h2>{t("Private by design.")}<br />{t("Simple by default.")}</h2><p>{t("Secure your connection with Stellar VPN and Stellar Relay, worldwide locations and quiet protection.")}</p><div className="auth-trust-row"><span>{t("✓ No activity logs")}</span><span>{t("✓ Encrypted connection")}</span></div></div></aside>
    <main className="auth-card"><header className="auth-product"><img src={appIcon} width={32} height={32} alt="" /><span>Stellar VPN</span></header><div className="auth-card-top">{t(view !== 'intro' && <button id="auth-back" className="auth-icon-button" aria-label={t("Go back")} disabled={busy} onClick={() => navigate(parents[view] || 'intro')}>←</button>)}<span id="auth-step-name" className="sr-only">{t(names[view])}</span></div>
      <div ref={stage} id="auth-stage" className="auth-stage" aria-live="polite"><div key={view} className="view-enter">
        {t(view === 'intro' ? <div className="auth-view"><Heading kicker={t("Welcome")} title={t("Welcome to Stellar VPN")}>{t("Encrypt your internet traffic with Stellar VPN and choose how you want to continue.")}</Heading><div className="auth-options"><button className="auth-primary" onClick={() => navigate('login')}>{t("Log in with Stellar ID")}</button><button className="auth-secondary" onClick={() => navigate('account')}>{t("Log in by account number")}</button></div><SignupOptions onRegister={() => navigate('register')} /></div>
        : <form className="auth-view auth-form" onSubmit={submit} noValidate>
          {t(view === 'login' && <><Heading kicker={t("Log in")} title={t("Welcome back")}>{t("Enter your email and password to continue to Stellar VPN.")}</Heading>{t(emailField)}<PasswordField name="password" label={t("Password")} /><div className="auth-form-row"><ExternalLink className="auth-text-button" href="https://id.stellarsecurity.com/auth/forgot-password">{t("Forgot password?")}</ExternalLink></div></>)}
          {t(view === 'register' && <><Heading kicker={t("New to Stellar")} title={t("Create a Stellar ID")}>{t("Create your Stellar ID with email and a password of at least 6 characters.")}</Heading>{t(emailField)}<PasswordField name="password" label={t("Password")} registration /></>)}
          {t(view === 'account' && <><Heading kicker={t("Alternative sign-in")} title={t("Use account number")}>{t("Enter the 16-digit account number connected to your Stellar VPN plan.")}</Heading><label className="auth-field"><span>{t("Account number")}</span><input className="auth-account-input" name="account" inputMode="numeric" pattern="[0-9]{16}" autoComplete="off" maxLength={32} value={accountNumber} onChange={event => setAccountNumber(accountDigits(event.target.value))} placeholder={t("0000 0000 0000 0000")} /></label></>)}
          {t(error && <p className="auth-error" role="alert">{t(error)}</p>)}
          <button className={`auth-primary ${busy ? 'auth-loading' : ''}`} type="submit" disabled={busy}><span>{t(view === 'register' ? 'Create a Stellar ID' : 'Log in')}</span></button>
          {t(view === 'login' && <SignupOptions onRegister={() => navigate('register')} />)}
          {t(view === 'register' && <p className="auth-switch">{t("Already have a Stellar ID?")} <button type="button" onClick={() => navigate('login')}>{t("Log in")}</button></p>)}
        </form>)}
      </div></div>
      <p className="preview-note">{t("You stay signed in until your session expires or you log out.")}</p>
      <p className="auth-legal">{t("By continuing, you agree to our")} <ExternalLink href="https://stellarvpn.org/terms-and-conditions">{t("Terms")}</ExternalLink> {t("and")} <ExternalLink href="https://stellarvpn.org/privacy-policy">{t("Privacy Policy")}</ExternalLink>.</p>
    </main></div></section>;
}
function AuthWorldBackdrop() {
  const { loadWorldMap } = useApp();
  const [map, setMap] = useState<WorldMap | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void loadWorldMap(abort.signal).then(value => { if (!abort.signal.aborted) setMap(value); }).catch(() => {});
    return () => abort.abort();
  }, [loadWorldMap]);
  return <svg className="auth-world-backdrop" viewBox="0 85 1100 590" aria-hidden="true" focusable="false">
    {map?.features.filter(feature => feature.properties.ADMIN !== 'Antarctica').map((feature, index) => <path key={index} d={geometryToPath(feature.geometry)} />)}
  </svg>;
}
