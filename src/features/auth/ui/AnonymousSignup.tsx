import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../shared/i18n/I18n';

/** The number is a login secret. Keep it in memory, never in URLs, analytics or browser storage. */
export function AnonymousSignup({ number, busy, error, onCreate, onContinue }: {
  number: string; busy: boolean; error: string; onCreate: () => void; onContinue: () => void;
}) {
  const t = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const numberInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (number) numberInput.current?.focus({ preventScroll: true }); }, [number]);
  async function copy() {
    try { await navigator.clipboard.writeText(number); setCopyStatus('Account number copied'); }
    catch { numberInput.current?.focus(); numberInput.current?.select(); setCopyStatus('Could not copy. Please try again.'); }
  }
  return <div className="auth-view auth-form" aria-busy={busy}>
    <div className="auth-view-header"><h1>{t(number ? 'Save your account number' : 'Create an anonymous account number')}</h1>
      <p>{t(number ? 'This number is your login. Keep it private and save it somewhere safe.' : 'No email or password needed. Create a personal 16-digit account number here in the app.')}</p>
    </div>
    {number ? <>
      <label className="auth-field"><span>{t('Account number')}</span><input ref={numberInput} className="auth-account-input auth-created-number" readOnly autoComplete="off" spellCheck={false} value={number.match(/.{4}/g)?.join(' ')} onFocus={event => event.currentTarget.select()} /></label>
      <button type="button" className="auth-secondary" onClick={() => void copy()}>{t('Copy account number')}</button>
      {copyStatus && <p className="auth-copy-status" role="status">{t(copyStatus)}</p>}
      <label className="auth-save-confirmation"><input type="checkbox" checked={saved} disabled={busy} onChange={event => setSaved(event.target.checked)} /><span>{t('I have saved my account number.')}</span></label>
    </> : null}
    {error && <p className="auth-error" role="alert">{t(error)}</p>}
    <button type="button" className={`auth-primary ${busy ? 'auth-loading' : ''}`} disabled={busy || (!!number && !saved)} onClick={number ? onContinue : onCreate}>
      <span>{t(number ? 'Log in' : 'Create an anonymous account number')}</span>
    </button>
  </div>;
}
