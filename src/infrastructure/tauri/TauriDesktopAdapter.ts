import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DesktopPort } from '../../application/ports/DesktopPort';
import type { ConnectionSnapshot, DesktopSnapshot, Session, Settings } from '../../contracts/desktop';
import { decodeSnapshot } from './decodeSnapshot';
import { HttpIdentityClient } from '../auth/HttpIdentityClient';

/** Only this adapter knows the IPC command names or Tauri APIs. */
export class TauriDesktopAdapter implements DesktopPort {
  private identity = new HttpIdentityClient();
  private async authenticate(operation: 'login' | 'register', email: string, password: string) {
    const expiresAt = await this.identity.authenticate(operation, email, password);
    try { return await invoke<Session>('accept_account_session', { expiresAt: Math.floor(expiresAt / 1000) }); }
    catch { await this.identity.logout().catch(() => {}); throw new Error('Could not open your session. Please log in again.'); }
  }
  login(email: string, password: string) { return this.authenticate('login', email, password); }
  register(email: string, password: string) { return this.authenticate('register', email, password); }
  subscribe(changed: (snapshot: DesktopSnapshot) => void) {
    return listen<unknown>('desktop-changed', event => changed(decodeSnapshot(event.payload)));
  }
  showMain() { return invoke<void>('show_main'); }
  selectLocation(serverId: string) { return invoke<void>('select_location', { serverId }); }
  showLocations() { return invoke<void>('show_locations'); }
  onShowLocations(callback: () => void) { return listen('show-locations', callback); }
  hideTray() { return invoke<void>('hide_tray'); }
  quit() { return invoke<void>('quit_preview'); }
  async bootstrap(): Promise<DesktopSnapshot> { return decodeSnapshot(await invoke<unknown>('bootstrap')); }
  openExternal(url: string) { return invoke<void>('open_stellar_link', { url }); }
  connect(serverId: string) { return invoke<ConnectionSnapshot>('connect_preview', { serverId }); }
  disconnect() { return invoke<ConnectionSnapshot>('disconnect_preview'); }
  saveSettings(settings: Settings) { return invoke<Settings>('save_settings', { settings }); }
  async logout() {
    let failed = false;
    try { await this.identity.logout(); } catch { failed = true; }
    const session = await invoke<Session>('logout');
    return Object.assign(session, failed ? { revocationPending: true } : {});
  }
  completeOnboarding() { return invoke<Session>('complete_onboarding'); }
}
