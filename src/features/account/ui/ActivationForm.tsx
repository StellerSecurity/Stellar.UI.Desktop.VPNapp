import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';

export function ActivationForm({ code, setCode }: { code: string; setCode: (value: string) => void }) {
  const t = useTranslation();
  const app = useApp();
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function activate() {
    if (busy.current) return;
    const value = code.trim();
    if (!/^[A-Za-z0-9-]{4,128}$/.test(value)) { setStatus('error'); setError('Enter a valid activation code.'); return; }
    busy.current = true; setStatus('pending'); setError('');
    try {
      await app.activateCode(value);
      if (mounted.current) { setCode(''); setStatus('done'); }
    } catch (failure) {
      if (mounted.current) { setStatus('error'); setError(failure instanceof Error ? failure.message : 'Activation could not be confirmed. Retry the same code.'); }
    } finally { busy.current = false; }
  }
  if (status === 'done') return <><p role="status">{t("Your activation code was applied. Your subscription is being refreshed.")}</p><div className="dialog-footer"><button className="dialog-primary close-dialog-text">{t("Done")}</button></div></>;
  return <form onSubmit={event => { event.preventDefault(); void activate(); }} aria-busy={status === 'pending'}>
    <p>{t("Redeem a code to add time to your VPN subscription.")}</p>
    <label className="field-label" htmlFor="activation-code">{t("Activation code")}</label>
    <input id="activation-code" className="dialog-input" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={128}
      value={code} disabled={status === 'pending'} aria-invalid={status === 'error'} aria-describedby={error ? 'activation-error' : undefined}
      onChange={event => { setCode(event.target.value); setStatus('idle'); setError(''); }} placeholder={t("Enter your code")} />
    {t(error && <p id="activation-error" className="activation-error" role="alert">{t(error)}</p>)}
    <div className="dialog-footer"><button type="button" className="dialog-cancel close-dialog-text">{t(status === 'pending' ? 'Close' : 'Cancel')}</button>
      <button type="submit" className="dialog-primary" disabled={status === 'pending' || !code.trim()}>{t(status === 'pending' ? 'Activating…' : 'Activate')}</button></div>
  </form>;
}
