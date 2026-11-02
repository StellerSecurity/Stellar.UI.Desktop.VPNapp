import { useTranslation, useLocale } from '../../../shared/i18n/I18n';
import { useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { describeSubscription } from '../domain/Account';
import { Skeleton } from '../../../shared/ui/Skeleton';
import { MoreStellarProducts } from './MoreStellarProducts';
export function AccountPage() {
  const t = useTranslation();
  const app = useApp(), account = app.account;
  const [shown, setShown] = useState(false);
  const [numberAnimated, setNumberAnimated] = useState(false);
  const locale = useLocale();
  const summary = account ? describeSubscription(account, Date.now(), locale) : null;
  const copy = (value: string) => { void navigator.clipboard.writeText(value).then(() => app.notify('Account number copied'), () => app.notify('Could not copy. Please try again.')); };
  return <section id="section-account" className="preference-section" aria-labelledby="account-tab"><div className="settings-card">
    {t(account && (account.cached || app.accountStatus === 'error') && <div className="account-data-toolbar"><span role="status">{t("Saved data")}</span></div>)}
    {t(!account && app.accountStatus === 'loading' && <div className="account-skeleton" role="status" aria-label={t("Loading account")} aria-busy="true">
      <div className="subscription-summary"><Skeleton className="skeleton-avatar" /><div className="subscription-copy"><Skeleton className="skeleton-label" /><Skeleton className="skeleton-title" /><Skeleton className="skeleton-line" /></div></div>
      <div className="account-actions"><Skeleton className="skeleton-action" /><Skeleton className="skeleton-action" /></div>
      <div className="account-number"><Skeleton className="skeleton-label" /><Skeleton className="skeleton-title" /></div>
    </div>)}
    {t(app.accountStatus === 'error' && !account && <div className="account-refresh-error"><button className="text-button" onClick={app.refreshAccount}>{t("Try again")}</button></div>)}
    {t(account && summary && <>
      <div className="subscription-summary" aria-label={t(summary.title)}><div className="subscription-days" aria-hidden="true">{t(summary.remaining !== null ? <><strong>{t(summary.remaining)}</strong><span>{t("days")}</span></> : <Icon name="calendar" />)}</div><div className="subscription-copy"><span className="eyebrow">{t("SUBSCRIPTION")}</span><h3>{t(summary.title)}</h3><p>{t(summary.description)}</p></div>{t((summary.date || summary.expired) && <div className="renewal-date" data-expired={summary.expired}><span>{t(summary.expired ? "Expired" : "Access expires")}</span>{summary.date && <strong>{t(summary.date)}</strong>}</div>)}</div>
      {t(account.subscriptionState === 'unavailable' && <p className="account-data-message">{t("Couldn’t load your subscription.")}<button className="text-button" onClick={app.refreshAccount}>{t("Try again")}</button></p>)}
      <div className="account-actions"><button id="manage-plan" className="secondary-action" onClick={() => app.setDialog('plan')}><span><Icon name="calendar" /></span><span><strong>{t("Plan details")}</strong><small>{t("View your subscription")}</small></span><i>›</i></button><button id="use-activation-code" className="secondary-action" onClick={event => { event.currentTarget.focus(); app.setDialog('activation'); }}><span><Icon name="key" /></span><span><strong>{t("Use activation code")}</strong><small>{t("Add time with a code")}</small></span><i>›</i></button></div>
      {t(account.subscription && <div className="account-number"><div className="number-heading"><strong>{t("VPN account number")}</strong></div><div className="number-value"><button className="account-number-reveal" aria-label={t(shown ? 'Hide VPN account number' : 'Show VPN account number')} aria-pressed={shown} onClick={() => { setNumberAnimated(true); setShown(value => !value); }}><code key={shown ? 'revealed' : 'masked'} className={numberAnimated ? 'account-number-fade' : undefined}>{t(shown ? account.subscription.id : '•••• •••• •••• ••••')}</code></button><button className="text-button" onClick={() => copy(account.subscription!.id)}>{t("Copy")}</button></div></div>)}
    </>)}
    <button id="trust-and-privacy" className="setting-row setting-action account-link" aria-haspopup="dialog" onClick={() => app.setDialog('trust')}><span className="row-icon"><Icon name="shield" /></span><span><strong>{t("Why trust Stellar VPN?")}</strong><small>{t("Swiss jurisdiction, privacy and no activity logs.")}</small></span><i className="action-arrow">›</i></button>
    <MoreStellarProducts />
    <button id="logout" className="setting-row setting-action danger-action" aria-haspopup="dialog" onClick={() => app.setDialog('logout')}><span className="row-icon"><Icon name="logout" /></span><span><strong>{t("Log out")}</strong><small>{t("Disconnect and remove this account from the device.")}</small></span><i className="action-arrow">›</i></button>
  </div></section>;
}
