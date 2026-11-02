import type { Settings } from '../../../contracts/desktop';
export type BooleanSetting = Exclude<keyof Settings, 'language'>;
export interface SettingsPort { saveSettings(settings: Settings): Promise<Settings> }
export const settingKeys = {
  'auto-connect': 'autoConnect', 'kill-switch': 'killSwitch', 'auto-rotate': 'autoRotate',
  notifications: 'notifications', 'menu-bar': 'menuBar'
} as const;
