import type { DesktopSnapshot } from '../../contracts/desktop';
import type { ConnectionPort } from '../../features/connection/domain/Connection';
import type { SettingsPort } from '../../features/settings/domain/Settings';
import type { SessionPort } from '../../features/auth/domain/Auth';
import type { AccountRepository } from '../../features/account/domain/Account';
export interface DesktopPort extends ConnectionPort, SettingsPort, SessionPort, AccountRepository {
  bootstrap(): Promise<DesktopSnapshot>;
  openExternal(url: string): Promise<void>;
  subscribe?(changed: (snapshot: DesktopSnapshot) => void): Promise<() => void>;
  showMain?(): Promise<void>;
  selectLocation?(id: string): Promise<void>;
  showLocations?(): Promise<void>;
  onShowLocations?(callback: () => void): Promise<() => void>;
  prepareRotation?(id: string, name: string): Promise<void>;
  onNativeConnectionState?(callback: (id: string | null) => void): Promise<() => void>;
  onAccountRefresh?(callback: (reason: 'resume' | 'periodic') => void): Promise<() => void>;
  hideTray?(): Promise<void>;
  quit?(): Promise<void>;
}
