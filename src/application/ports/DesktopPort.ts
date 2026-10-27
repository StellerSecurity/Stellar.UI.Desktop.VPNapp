import type { DesktopSnapshot } from '../../contracts/desktop';
import type { ConnectionPort } from '../../features/connection/domain/Connection';
import type { SettingsPort } from '../../features/settings/domain/Settings';
import type { SessionPort } from '../../features/auth/domain/Auth';
export interface DesktopPort extends ConnectionPort, SettingsPort, SessionPort {
  bootstrap(): Promise<DesktopSnapshot>;
  openExternal(url: string): Promise<void>;
  subscribe?(changed: (snapshot: DesktopSnapshot) => void): Promise<() => void>;
  showMain?(): Promise<void>;
  selectLocation?(id: string): Promise<void>;
  showLocations?(): Promise<void>;
  onShowLocations?(callback: () => void): Promise<() => void>;
  hideTray?(): Promise<void>;
  quit?(): Promise<void>;
}
