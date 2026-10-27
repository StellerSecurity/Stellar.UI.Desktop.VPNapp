import { ExternalLink } from '../../../shared/ui/ExternalLink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../../app/AppProvider';
import { validateAuth, type AuthView } from '../domain/Auth';
import { Icon } from '../../../shared/ui/Icon';
import logoUrl from '../../../../assets/stellar-vpn-logo.png';
const names: Record<AuthView, string> = { intro: 'Welcome', login: 'Log in', register: 'Create account', account: 'Account number', forgot: 'Password recovery', otp: 'Verification', reset: 'New password' };
const parents: Partial<Record<AuthView, AuthView>> = { login: 'intro', register: 'intro', account: 'intro', forgot: 'login', otp: 'forgot', reset: 'otp' };
function Heading({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return <div className="auth-view-header"><span className="auth-kicker">{kicker}</span><h1>{title}</h1><p>{children}</p></div>;
}
function PasswordField({ label, name, registration = false }: { label: string; name: string; registration?: boolean }) {
  const [visible, setVisible] = useState(false);
  return <label className="auth-field"><span>{label}</span><div className="auth-input-wrap"><input name={name} type={visible ? 'text' : 'password'} autoComplete={registration ? 'new-password' : 'current-password'} placeholder={registration ? 'At least 12 characters' : 'Enter your password'} /><button className="auth-password-toggle" type="button" aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} aria-pressed={visible} onClick={() => setVisible(!visible)}><Icon name="eye" /></button></div></label>;
}
export function AuthFlow() {
  const app = useApp();
  const [view, setView] = useState<AuthView>('intro'), [email, setEmail] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { stage.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true }); }, [view]);
  function navigate(next: AuthView) { setError(''); setView(next); }
  async function authenticate(operation: 'login' | 'register', email: string, password: string) {
    setBusy(true);
    try { await app.authenticate(operation, email, password); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not log in. Please try again.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    if (view === 'otp') data.code = [...event.currentTarget.querySelectorAll<HTMLInputElement>('.auth-code input')].map(input => input.value).join('');
    const message = validateAuth(view, data);
    if (message) { setError(message); return; }
    setError('');
    if (data.email) setEmail(data.email);
    if (view === 'forgot') { navigate('otp'); return; }
    if (view === 'otp') { navigate('reset'); return; }
    if (view === 'reset') { navigate('login'); app.notify('Recovery flow preview completed. No password was changed.'); return; }
    if (view !== 'login' && view !== 'register') { setError('Account-number sign-in is not connected yet. Please log in with email.'); return; }
    const password = data.password;
    event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="password"], input[name="password"]').forEach(input => { input.value = ''; });
    delete data.password;
    await authenticate(view, data.email, password);
  }
  const emailField = <label className="auth-field"><span>Email</span><input name="email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>;
  return <section id="auth-flow" className="auth-flow" aria-label="Sign in to Stellar VPN"><div className="auth-shell"><aside className="auth-brand" aria-hidden="true"><img src={logoUrl} width={500} height={128} alt="" /><div className="auth-brand-copy"><span>SWISS PRIVACY</span><h2>Private by design.<br />Simple by default.</h2><p>Secure your connection with Stellar Relay, worldwide locations and quiet protection.</p></div><div className="auth-route-art"><i /><i /><i /><span>✓</span></div><div className="auth-trust-row"><span>✓ No activity logs</span><span>✓ Encrypted connection</span></div></aside>
    <main className="auth-card"><div className="auth-card-top">{view !== 'intro' && <button id="auth-back" className="auth-icon-button" aria-label="Go back" disabled={busy} onClick={() => navigate(parents[view] || 'intro')}>←</button>}<span id="auth-step-name">{names[view]}</span></div>
      <div ref={stage} id="auth-stage" className="auth-stage" aria-live="polite"><div key={view} className="view-enter">
        {view === 'intro' ? <div className="auth-view"><Heading kicker="Welcome to Stellar VPN" title="Secure VPN, without the noise.">Encrypt your internet traffic with Stellar VPN and choose how you want to continue.</Heading><div className="auth-options"><button className="auth-secondary" onClick={() => navigate('account')}>Log in by account number</button><button className="auth-primary" onClick={() => navigate('login')}>Log in</button></div><p className="auth-switch">Don’t have an account? <button onClick={() => navigate('register')}>Create an account</button></p></div>
        : <form className="auth-view auth-form" onSubmit={submit} noValidate>
          {view === 'login' && <><Heading kicker="Welcome back" title="Log in">Enter your email and password to continue to Stellar VPN.</Heading>{emailField}<PasswordField name="password" label="Password" /><div className="auth-form-row"><button className="auth-text-button" type="button" onClick={() => navigate('forgot')}>Forgot password?</button></div></>}
          {view === 'register' && <><Heading kicker="New to Stellar" title="Create account">Create your Stellar account with email and a password of at least 12 characters.</Heading>{emailField}<PasswordField name="password" label="Password" registration /></>}
          {view === 'account' && <><Heading kicker="Alternative sign-in" title="Use account number">Enter the 16-digit account number connected to your Stellar VPN plan.</Heading><label className="auth-field"><span>Account number</span><input className="auth-account-input" name="account" inputMode="numeric" autoComplete="off" maxLength={19} placeholder="0000 0000 0000 0000" /></label></>}
          {view === 'forgot' && <><Heading kicker="Password recovery" title="Forgot password?">Enter your email to preview the four-digit verification flow.</Heading>{emailField}</>}
          {view === 'otp' && <><Heading kicker="Check your inbox" title="Please input code">Preview the account verification code for <strong>{email}</strong>.</Heading><div className="auth-code" aria-label="Four-digit verification code">{[0, 1, 2, 3].map(index => <input key={index} aria-label={`Digit ${index + 1}`} inputMode="numeric" maxLength={1} pattern="[0-9]*" autoComplete={index === 0 ? 'one-time-code' : 'off'} onChange={event => { event.target.value = event.target.value.replace(/\D/g, '').slice(-1); if (event.target.value) (event.target.nextElementSibling as HTMLInputElement | null)?.focus(); }} onKeyDown={event => { if (event.key === 'Backspace' && !event.currentTarget.value) (event.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus(); }} onPaste={event => { const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4); if (digits.length > 1) { event.preventDefault(); const inputs = stage.current!.querySelectorAll<HTMLInputElement>('.auth-code input'); digits.split('').forEach((digit, i) => { inputs[i].value = digit; }); inputs[Math.min(digits.length, 3)].focus(); } }} />)}</div><p className="auth-switch">Didn’t receive a code? <button type="button" onClick={() => app.notify('Preview only: no email is sent.')}>Resend code</button></p></>}
          {view === 'reset' && <><Heading kicker="Almost done" title="Create new password">Choose a new password for your Stellar VPN account.</Heading><PasswordField name="password" label="New password" registration /><PasswordField name="confirm" label="Confirm password" registration /></>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className={`auth-primary ${busy ? 'auth-loading' : ''}`} type="submit" disabled={busy}><span>{view === 'register' ? 'Create account' : view === 'forgot' ? 'Send code' : view === 'otp' ? 'Verify code' : view === 'reset' ? 'Confirm' : 'Log in'}</span></button>
          {view === 'login' && <p className="auth-switch">Don’t have an account? <button type="button" onClick={() => navigate('register')}>Create an account</button></p>}
          {view === 'register' && <p className="auth-switch">Already have an account? <button type="button" onClick={() => navigate('login')}>Log in</button></p>}
        </form>}
      </div></div>
      <p className="preview-note">Account sign-in uses Stellar staging. Sessions last until expiry or app restart. VPN connections and password recovery remain previews.</p>
      <p className="auth-legal">By continuing, you agree to our <ExternalLink href="https://stellarvpn.org/terms-and-conditions">Terms</ExternalLink> and <ExternalLink href="https://stellarvpn.org/privacy-policy">Privacy Policy</ExternalLink>.</p>
    </main></div></section>;
}
