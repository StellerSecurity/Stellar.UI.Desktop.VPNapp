import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { Skeleton } from '../../../shared/ui/Skeleton';

export function DevicesPage() {
  const t = useTranslation();
  const app = useApp(), account = app.account;
  const count = account?.devices?.length ?? 0;
  return <section id="section-devices" className="preference-section devices-page" aria-labelledby="tab-devices">
    {t(account && (account.cached || app.accountStatus === 'error') && <div className="account-data-toolbar"><span role="status">{t("Saved data")}</span></div>)}
    {t(!account && app.accountStatus === 'loading' && <div role="status" aria-label={t("Loading devices")} aria-busy="true"><Skeleton className="skeleton-label" /><div className="account-device-list">{t([0, 1, 2, 3].map(row => <div className="account-device" key={row}><Skeleton className="skeleton-device-icon" /><Skeleton className="skeleton-line" /></div>))}</div></div>)}
    {t(!account && app.accountStatus === 'error' && <p className="account-data-message" role="alert">{t("Couldn’t load your devices.")}<button className="text-button" onClick={app.refreshAccount}>{t("Try again")}</button></p>)}
    {t(account && <div className="account-devices"><div className="number-heading"><strong>{t("Registered devices")}</strong><span>{t(account.devicesState === 'available' ? `${count} ${count === 1 ? 'device' : 'devices'}` : 'Unavailable')}</span></div>
      {t(account.devicesState === 'available' ? count ? <div className="account-device-list" role="list">{t(account.devices!.map(device => <div className="account-device" role="listitem" key={device.id}><span className="account-device-icon"><Icon name="computer" /></span><div className="account-device-copy"><strong>{device.name}</strong></div></div>))}</div> : <p className="account-data-message">{t("No registered devices.")}</p>
        : <p className="account-data-message">{t(account.devicesState === 'not_applicable' ? 'No VPN subscription.' : <>{t("Couldn’t load your devices.")}<button className="text-button" onClick={app.refreshAccount}>{t("Try again")}</button></>)}</p>)}
    </div>)}
  </section>;
}
