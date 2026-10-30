import { isTauri } from '@tauri-apps/api/core';
import { BrowserDesktopAdapter } from '../infrastructure/preview/BrowserDesktopAdapter';
import { TauriDesktopAdapter } from '../infrastructure/tauri/TauriDesktopAdapter';
import { StagingServerRepository } from '../infrastructure/catalog/StagingServerRepository';
import { ConnectionService } from '../features/connection/application/ConnectionService';
import { loadWorldMap } from '../infrastructure/catalog/BundledMapRepository';
import type { AccountRepository } from '../features/account/domain/Account';
import { SettingsService } from '../features/settings/application/SettingsService';
import { SessionService } from '../features/auth/application/SessionService';
import type { DesktopPort } from '../application/ports/DesktopPort';
import { LocalFavorites } from '../infrastructure/persistence/LocalFavorites';
import { TauriUpdateAdapter } from '../infrastructure/tauri/TauriUpdateAdapter';

/** Composition root: dependency choices happen here, never inside a UI component. */
export function createContainer() {
  const desktop: DesktopPort = isTauri() ? new TauriDesktopAdapter() : new BrowserDesktopAdapter();
  return { desktop, connection: new ConnectionService(desktop), settings: new SettingsService(desktop),
    session: new SessionService(desktop), servers: new StagingServerRepository(),
    account: desktop as AccountRepository, updates: new TauriUpdateAdapter(), favorites: new LocalFavorites(), loadWorldMap };
}
export type Container = ReturnType<typeof createContainer>;
