import { isTauri } from '@tauri-apps/api/core';
import { BrowserDesktopAdapter } from '../infrastructure/preview/BrowserDesktopAdapter';
import { TauriDesktopAdapter } from '../infrastructure/tauri/TauriDesktopAdapter';
import { ProductionServerRepository } from '../infrastructure/catalog/ProductionServerRepository';
import { ConnectionService } from '../features/connection/application/ConnectionService';
import { loadWorldMap } from '../infrastructure/catalog/BundledMapRepository';
import type { AccountRepository } from '../features/account/domain/Account';
import { SettingsService } from '../features/settings/application/SettingsService';
import { SessionService } from '../features/auth/application/SessionService';
import type { DesktopPort } from '../application/ports/DesktopPort';
import { LocalFavorites } from '../infrastructure/persistence/LocalFavorites';
import { TauriUpdateAdapter } from '../infrastructure/tauri/TauriUpdateAdapter';
import { InstallationService } from '../features/setup/application/InstallationService';
import { TauriInstallationAdapter } from '../infrastructure/tauri/TauriInstallationAdapter';

/** Composition root: dependency choices happen here, never inside a UI component. */
export function createContainer() {
  const desktop: DesktopPort = isTauri() ? new TauriDesktopAdapter() : new BrowserDesktopAdapter();
  return { desktop, installation: new InstallationService(new TauriInstallationAdapter()), connection: new ConnectionService(desktop), settings: new SettingsService(desktop),
    session: new SessionService(desktop), servers: new ProductionServerRepository(),
    account: desktop as AccountRepository, updates: new TauriUpdateAdapter(), favorites: new LocalFavorites(), loadWorldMap };
}
export type Container = ReturnType<typeof createContainer>;
