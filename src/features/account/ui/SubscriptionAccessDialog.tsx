import { useApp } from '../../../app/AppProvider';
import { useTranslation } from '../../../shared/i18n/I18n';
import { Dialog } from '../../../shared/ui/Dialog';

export function SubscriptionAccessDialog({ compact = false }: { compact?: boolean }) {
  const app = useApp(), t = useTranslation();
  return <Dialog id="subscription-access" title={t('VPN subscription inactive')} className={compact ? 'tray-quit-dialog' : ''} onClose={() => app.setDialog(null)}>
    <p>{t('An active VPN subscription is required.')}</p><p>{t('Renew your subscription or use an activation code in Account.')}</p>
    {app.snapshot?.connection.trafficBlocked && <p>{t('Kill switch is blocking traffic')}</p>}
    <div className={compact ? 'tray-quit-actions' : 'dialog-footer'}><button data-dialog-initial-focus className="dialog-cancel close-dialog-text" type="button">{t('Close')}</button><button className="dialog-primary" type="button" onClick={() => { app.setDialog(null); if (compact) void app.showMain(); else app.setView('account'); }}>{t(compact ? 'Open Stellar VPN' : 'Account')}</button></div>
  </Dialog>;
}
