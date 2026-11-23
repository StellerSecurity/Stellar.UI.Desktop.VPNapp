import { useTranslation } from '../../../shared/i18n/I18n';
import { useApp } from '../../../app/AppProvider';
import { settingKeys } from '../domain/Settings';
export function Toggle({ name, label, disabled = false }: { name: keyof typeof settingKeys; label: string; disabled?: boolean }) {
  const t = useTranslation();
  const app = useApp(), key = settingKeys[name];
  const settings = app.settingsDraft ?? app.snapshot?.settings;
  return <button className="toggle" data-setting={name} data-pending={app.settingsPending || undefined} role="switch" disabled={disabled || app.settingsPending} aria-busy={app.settingsPending || undefined} aria-checked={!disabled && !!settings?.[key]} aria-label={t(label)} onClick={() => app.toggleSetting(key)} />;
}
