import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nProvider, useTranslation } from '../../../shared/i18n/I18n';
import { Icon } from '../../../shared/ui/Icon';
import type { InstallationService } from '../application/InstallationService';
import { requiresInstallationHelp, type InstallationStatus } from '../domain/Installation';
import { installationHelpState } from '../domain/InstallationHelpState';
import appIcon from '../../../../assets/app-icon.png';
import './installation.css';

// Read-only background check. Keep the original login mounted, including entered values.
export function InstallationGate({ service, children }: { service: InstallationService; children: ReactNode }) {
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [opened, setOpened] = useState(false), [opening, setOpening] = useState(false), [openError, setOpenError] = useState(false);
  const generation = useRef(0), previousFocus = useRef<HTMLElement | null>(null);
  const showHelp = requiresInstallationHelp(status, error);
  const heading = useRef<HTMLHeadingElement>(null);
  async function check() {
    const attempt = ++generation.current; setBusy(true);
    try {
      const result = await service.check();
      if (attempt !== generation.current) return;
      setStatus(result); setError(false); setOpenError(false);
    } catch { if (attempt === generation.current) setError(true); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  useEffect(() => { void check(); return () => { ++generation.current; }; }, [service]);
  useEffect(() => {
    if (!opened) return;
    const focus = () => { void check(); };
    window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus);
  }, [opened, service]);
  async function openHelper() {
    if (opening || busy) return;
    setOpening(true); setOpenError(false);
    try { await service.openHelper(); setOpened(true); }
    catch { setOpenError(true); }
    finally { setOpening(false); }
  }
  useEffect(() => {
    if (!showHelp) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus({ preventScroll: true });
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }); };
  }, [showHelp]);
  return <>
    <div hidden={showHelp}>{children}</div>
    {showHelp && <I18nProvider language={status?.language || 'English'}>
      <InstallationHelp status={status} busy={busy || opening} error={error} opened={opened} openError={openError} openHelper={() => void openHelper()} check={() => void check()} heading={heading} />
    </I18nProvider>}
  </>;
}
function InstallationHelp({ status, busy, error, opened, openError, openHelper, check, heading }: {
  opened: boolean; openError: boolean; openHelper: () => void;
  status: InstallationStatus | null; busy: boolean; error: boolean; check: () => void;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  const t = useTranslation();
  // Preserve every existing translation/layout; only the platform name changes.
  const platformText = (text: string) => status?.platform === 'windows' ? t(text).replaceAll('macOS', 'Windows') : t(text);
  const help = installationHelpState(status, error, openError, opened);
  return <main className="installation-recovery" aria-labelledby="installation-title">
    <header><img src={appIcon} alt="" /><span>Stellar VPN</span></header>
    <section className="installation-recovery-card">
      <span className="installation-recovery-icon" aria-hidden="true"><Icon name="shield" /></span>
      <h1 id="installation-title" ref={heading} tabIndex={-1}>{t(help.title)}</h1>
      <p>{t(help.description)}</p>
      {help.diagnostic && <p className="installation-recovery-status" role={help.alert ? 'alert' : 'status'}>{platformText(help.diagnostic)}</p>}
      <button disabled={busy} onClick={help.retryOnly || opened ? check : openHelper}>{t(busy ? 'Please wait…' : help.button)}<Icon name="right" /></button>
      {opened && !help.retryOnly && <button className="installation-helper-reopen" disabled={busy} onClick={openHelper}>{t('Install network helper')}</button>}
      <small><Icon name="key" /><span>{platformText(help.footnote)}</span></small>
    </section>
  </main>;
}
