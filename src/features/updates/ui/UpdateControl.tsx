import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Dialog } from '../../../shared/ui/Dialog';
import { mayInstall } from '../domain/Update';
import { useState } from 'react';
export function UpdateControl() {
  const t = useTranslation();
  const app = useApp(), state = app.update;
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(state.phase);
  const installable = mayInstall(state, app.snapshot?.connection.status, !!app.snapshot?.connection.trafficBlocked, app.pending);
  const label = state.phase === 'ready' ? 'Ready to install' : state.phase === 'available' ? `Version ${state.version} available` : state.phase === 'current' ? 'You’re up to date' : state.phase === 'checking' ? 'Checking for updates…' : state.phase === 'downloading' ? 'Downloading update…' : state.phase === 'unsupported' ? 'Updates unavailable on this platform' : 'Software updates';
  return <>
    <div className="settings-card compact-card update-settings">
      <div className="section-label">{t("SOFTWARE UPDATES")}</div>
      <div className="setting-row"><div><strong>{t(label)}</strong><p>{t(state.message || `Version ${state.currentVersion} · Signed updates only`)}</p></div>
        <button className="update-action" disabled={busy || state.phase === 'unsupported'} onClick={() => { if (state.version) setOpen(true); else void app.checkUpdate(); }}>{t(state.version ? 'View update' : 'Check for updates')}</button>
      </div>
    </div>
    {t(open && <Dialog id="software-update" title={t(state.phase === 'ready' ? 'Update verified' : 'Software update')} className="update-dialog" onClose={() => setOpen(false)}>
      <div className="update-summary"><span className="feature-icon"><Icon name="shield" /></span><div><strong>{t("Stellar VPN")}{t(state.version)}</strong><p>{t(state.phase === 'ready' ? 'The package signature matches Stellar’s built-in public key.' : 'The download must pass Stellar’s signing-key verification before installation.')}</p></div></div>
      {t(state.notes && <p className="update-notes">{t(state.notes)}</p>)}
      {t(state.phase === 'downloading' && <p role="status">{t("Downloaded")}{t((state.downloaded / 1048576).toFixed(1))} {t("MB…")}</p>)}
      {t(state.message && <p role="status">{t(state.message)}</p>)}
      {t(state.phase === 'ready' && !installable && <p>{t("Disconnect VPN before installing. Stellar will not disconnect or unblock your internet for an update.")}</p>)}
      {t(state.phase === 'ready' && <p>{t("Installation restarts the app. Your current auto-connect setting applies after restart.")}</p>)}
      <div className="dialog-footer"><button className="dialog-cancel close-dialog-text">{t("Later")}</button>
        {t(state.phase === 'downloading' ? <button className="dialog-primary" onClick={() => void app.cancelUpdate()}>{t("Cancel download")}</button>
          : state.phase === 'ready' ? <button className="dialog-primary" disabled={!installable} onClick={() => void app.installUpdate()}>{t("Install and restart")}</button>
          : <button className="dialog-primary" disabled={busy} onClick={() => void app.downloadUpdate()}>{t("Download update")}</button>)}
      </div>
    </Dialog>)}
  </>;
}
