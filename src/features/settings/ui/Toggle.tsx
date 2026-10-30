import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { settingKeys } from '../domain/Settings';
export function Toggle({ name, label, disabled = false }: { name: keyof typeof settingKeys; label: string; disabled?: boolean }) {
  const t = useTranslation();
  const app = useApp(), key = settingKeys[name];
  return <button className="toggle" data-setting={name} role="switch" disabled={disabled} aria-checked={!disabled && !!app.snapshot?.settings[key]} aria-label={t(label)} onClick={() => app.toggleSetting(key)} />;
}
