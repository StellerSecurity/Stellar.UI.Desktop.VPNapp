import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { useLocale, useTranslation } from '../../../shared/i18n/I18n';
import { Dialog } from '../../../shared/ui/Dialog';
import { Skeleton } from '../../../shared/ui/Skeleton';
import type { DeviceLogin } from '../domain/DeviceSession';

export function DeviceLogins() {
  const app = useApp(), t = useTranslation(), locale = useLocale();
  const [sessions, setSessions] = useState<DeviceLogin[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<DeviceLogin | null>(null);
  const epoch = useRef(0), busy = useRef(false);
  async function load(after?: string) {
    if (busy.current) return;
    const current = epoch.current;
    busy.current = true; setPending(true); setError('');
    try {
      const page = await app.listDeviceSessions(after);
      if (current !== epoch.current) return;
      setSessions(previous => after ? [...(previous ?? []), ...page.sessions] : page.sessions);
      setCursor(page.nextCursor);
    } catch {
      if (current === epoch.current) setError('Could not load signed-in devices. Please try again.');
    } finally {
      if (current === epoch.current) { busy.current = false; setPending(false); }
    }
  }
  useEffect(() => {
    ++epoch.current; busy.current = false; setSessions(null); setCursor(null); setTarget(null);
    void load();
    return () => { ++epoch.current; };
  }, [app.snapshot?.session.identityRevision]);
  async function revoke() {
    if (!target || busy.current) return;
    const current = epoch.current, id = target.id;
    busy.current = true; setPending(true); setError('');
    try {
      await app.revokeDeviceSession(id);
      if (current !== epoch.current) return;
      setSessions(previous => previous?.map(row => row.id === id ? { ...row, revoked: true } : row) ?? null);
      setTarget(null);
    } catch {
      if (current === epoch.current) setError('Could not confirm session revocation. Please try again.');
    } finally {
      if (current === epoch.current) { busy.current = false; setPending(false); }
    }
  }
  const date = (row: DeviceLogin) => new Date(row.createdAt).toLocaleString(locale);
  return <div className="account-devices">
    <div className="number-heading"><strong>{t('Signed-in devices')}</strong><button className="text-button" disabled={pending} onClick={() => void load()}>{t('Refresh')}</button></div>
    <p className="account-data-message">{t('Remove a login from a lost device. Your other devices stay signed in.')}</p>
    {sessions === null && pending && <div role="status" aria-label={t('Loading devices')}><Skeleton className="skeleton-line" /></div>}
    {sessions && <div className="account-device-list" role="list">{sessions.map(row => <div className="account-device" role="listitem" key={row.id}>
      <div className="account-device-copy"><strong>{t(row.current ? 'This device' : 'Device login')} · {row.id.slice(-8)}</strong><small>{date(row)}{row.revoked ? ` · ${t('Signed out')}` : ''}</small></div>
      {!row.current && !row.revoked && <button className="text-button danger-action" disabled={pending} onClick={() => setTarget(row)}>{t('Remove login')}</button>}
    </div>)}</div>}
    {error && <p className="account-data-message" role="alert">{t(error)}</p>}
    {cursor && <button className="text-button" disabled={pending} onClick={() => void load(cursor)}>{t('Load more')}</button>}
    {target && <Dialog id="revoke-device-login" title={t('Remove this login?')} onClose={() => setTarget(null)}>
      <p>{t('This device will need to sign in again. Your other devices stay signed in.')}</p>
      <p>{date(target)} · {target.id.slice(-8)}</p>
      {error && <p role="alert">{t(error)}</p>}
      <div className="dialog-footer"><button className="dialog-cancel close-dialog-text" data-dialog-initial-focus>{t('Cancel')}</button><button className="dialog-primary" disabled={pending} onClick={() => void revoke()}>{t(pending ? 'Removing…' : 'Remove login')}</button></div>
    </Dialog>}
  </div>;
}
