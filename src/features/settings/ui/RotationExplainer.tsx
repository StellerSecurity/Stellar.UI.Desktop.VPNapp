import { useTranslation } from '../../../shared/i18n/I18n';
import { Icon } from '../../../shared/ui/Icon';
import './rotation-explainer.css';

export function RotationExplainer() {
  const t = useTranslation();
  return <>
    <div className="rotation-scene">
      <span className="rotation-brand">STELLAR VPN</span>
      <div className="rotation-orbit" aria-hidden="true"><span><Icon name="globe" /></span><i /><strong><Icon name="rotate" /></strong><i /><span><Icon name="globe" /></span></div>
      <div className="rotation-labels"><span>{t('Connected location')}</span><strong>{t('Every 7 days')}</strong><span>{t('Prepared location')}</span></div>
    </div>
    <p className="rotation-intro">{t('Change location every 7 days while connected.')}</p>
    <div className="rotation-details">
      <div><Icon name="power" /><span><strong>{t('Only while connected')}</strong><small>{t('Stops when you disconnect.')}</small></span></div>
      <div><Icon name="info" /><span><strong>{t('Notifications')}</strong><small>{t('Receive a notification when the app is in the background.')}</small></span></div>
    </div>
    <div className="dialog-footer"><button className="dialog-primary close-dialog-text">{t('Got it')}</button></div>
  </>;
}
