import { useTranslation, useLocale } from '../shared/i18n/I18n';
import { ExternalLink } from '../shared/ui/ExternalLink';
import { useEffect, useState } from 'react';
import { ActivationForm } from '../features/account/ui/ActivationForm';
import { useApp } from './AppProvider';
import { Dialog } from '../shared/ui/Dialog';
import { Icon } from '../shared/ui/Icon';
import { describeSubscription } from '../features/account/domain/Account';
import { SubscriptionAccessDialog } from '../features/account/ui/SubscriptionAccessDialog';
export function DialogHost() {
  const t = useTranslation();
  const locale = useLocale();
  const app = useApp();
  const [code, setCode] = useState('');
  useEffect(() => { if (!app.snapshot?.session.authenticated) setCode(''); }, [app.snapshot?.session.authenticated]);
  if (!app.dialog) return null;
  if (app.dialog === 'subscription') return <SubscriptionAccessDialog />;
  const id = app.dialog, titles = { 'auto-rotate': 'How Auto Rotate works', plan: 'Your plan', activation: 'Use activation code', trust: 'Why trust Stellar VPN?', logout: 'Log out of Stellar VPN?' };
  return <Dialog key={id} id={id} title={t(titles[id])} className={id === 'auto-rotate' ? 'auto-rotate-dialog' : id === 'trust' ? 'trust-dialog' : ''} onClose={() => app.setDialog(null)}>
    {t(id === 'auto-rotate' && <><p>{t("While connected, Stellar VPN changes to a prepared location every 7 days. It stops when you disconnect. You receive a notification when the app is in the background.")}</p><div className="dialog-footer"><button className="dialog-primary close-dialog-text">{t("Got it")}</button></div></>)}
    {t(id === 'plan' && <><div className="plan-status"><span><Icon name="calendar" /></span><div><strong>{t(app.account ? describeSubscription(app.account, Date.now(), locale).title : 'Account details unavailable')}</strong><p>{t(app.account ? describeSubscription(app.account, Date.now(), locale).description : 'Refresh the Account page to try again.')}</p></div></div><div className="dialog-footer"><button className="dialog-cancel close-dialog-text">{t("Close")}</button></div></>)}
    {t(id === 'activation' && <ActivationForm code={code} setCode={setCode} />)}
    {t(id === 'trust' && <>{t(([{ icon: 'building', title: 'Swiss ownership', body: 'Stellar VPN is owned and operated by Stellar Security, a Swiss-based company.' }, { icon: 'shield', title: 'Privacy-first jurisdiction', body: 'Swiss privacy laws help protect your data from third-party interference.' }, { icon: 'noLogs', title: 'No activity logs', body: 'Stellar VPN does not track or log your online activity.' }] as const).map(point => <div key={point.title} className="trust-point"><span><Icon name={point.icon} /></span><div><strong>{t(point.title)}</strong><p>{t(point.body)}</p></div></div>))}<div className="dialog-footer"><ExternalLink className="dialog-link" href="https://stellarvpn.org/privacy-policy">{t("Privacy policy ↗")}</ExternalLink><button className="dialog-primary close-dialog-text">{t("Got it")}</button></div></>)}
    {t(id === 'logout' && <><p>{t("Your VPN connection will be disconnected and this account will be removed from the device.")}</p><div className="dialog-footer"><button className="dialog-cancel close-dialog-text">{t("Cancel")}</button><button id="confirm-logout" className="dialog-danger" onClick={() => void app.logout()}>{t("Log out")}</button></div></>)}
  </Dialog>;
}
