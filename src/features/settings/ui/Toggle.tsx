import { useApp } from '../../../app/AppProvider';
import { settingKeys } from '../domain/Settings';
export function Toggle({ name, label }: { name: keyof typeof settingKeys; label: string }) {
  const app = useApp(), key = settingKeys[name];
  return <button className="toggle" data-setting={name} role="switch" aria-checked={!!app.snapshot?.settings[key]} aria-label={label} onClick={() => app.toggleSetting(key)} />;
}
