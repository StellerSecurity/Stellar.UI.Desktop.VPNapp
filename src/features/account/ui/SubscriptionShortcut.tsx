import { useEffect, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { useLocale, useTranslation } from '../../../shared/i18n/I18n';
import { Icon } from '../../../shared/ui/Icon';
import { describeSubscription, subscriptionExpiring } from '../domain/Account';

/** Reuses the account's validated expiry; missing data must never become “0 days”. */
export function SubscriptionShortcut() {
  const app = useApp(), t = useTranslation(), locale = useLocale();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const subscription = app.account ? describeSubscription(app.account, now, locale) : null;
  const denied = app.snapshot?.subscriptionAccess?.active === false;
  const label = subscription?.expired ? t('Expired') : denied ? t('VPN subscription inactive') : subscription?.remaining !== null && subscription?.remaining !== undefined
    ? `${subscription.remaining} ${t(subscription.remaining === 1 ? 'day' : 'days')}` : subscription ? t(subscription.title) : t('Account');
  const warning = denied || subscriptionExpiring(app.account, now);
  return <button type="button" className="subscription-shortcut" onClick={() => app.setView('account')}
    data-warning={warning}
    aria-label={`${t('Account')}: ${label}`} title={denied ? t('An active VPN subscription is required.') : app.account?.cached ? t('Last known subscription') : subscription ? t(subscription.description) : t('Account')}>
    <Icon name="calendar" /><span>{label}</span><Icon name="right" />
  </button>;
}
