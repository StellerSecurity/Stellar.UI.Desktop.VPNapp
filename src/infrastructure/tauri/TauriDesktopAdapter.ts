import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DesktopPort } from '../../application/ports/DesktopPort';
import type { ConnectionSnapshot, DesktopSnapshot, Session, Settings } from '../../contracts/desktop';
import { decodeSnapshot } from './decodeSnapshot';
import { HttpIdentityClient, SessionRejected, type RememberedIdentity } from '../auth/HttpIdentityClient';
import { sessionFailure } from '../auth/SessionFailure';
import catalog from '../../../assets/servers.json';
import { ConnectionDeadline } from '../../application/ConnectionDeadline';
import { vpnAccess } from '../../features/account/domain/VpnAccess';

/** Only this adapter knows the IPC command names or Tauri APIs. */
export class TauriDesktopAdapter implements DesktopPort {
  private identity = new HttpIdentityClient(undefined, async (accountData, expectedToken) => { await invoke('write_cached_account', { accountData, expectedToken }); }, async (access, expectedToken) => { await invoke('update_subscription_access', { access, expectedToken }); });
  private restoration?: Promise<void>;
  private attempt?: { controller: AbortController; native: boolean; cancellation?: Promise<ConnectionSnapshot> };
  private async rejected(error: unknown): Promise<never> {
    if (error instanceof SessionRejected) await invoke('logout').catch(() => {});
    throw error;
  }
  private restoreIdentity() {
    return this.restoration ??= (async () => {
      try {
        const saved = await invoke<unknown>('restore_account_session');
        if (saved) {
          this.identity.restore(saved);
          // The unexpired local session opens immediately. Verify revocation in
          // the background; a network outage must not erase a valid saved login.
          void this.identity.verifyRestoredSession().catch(error => {
            if (error instanceof SessionRejected) void invoke('logout', { expectedToken: (saved as RememberedIdentity).accessToken }).catch(() => {});
          });
        }
      } catch { /* A denied/locked OS vault leaves the ordinary login available. */ }
    })();
  }
  private async authenticate(operation: 'login' | 'register' | 'account', email: string, password: string) {
    let session: Session | undefined;
    const phase: { value: 'identity' | 'native' } = { value: 'identity' };
    try {
      await this.identity.authenticate(operation, email, password, async (expiresAt, vpnAuth, identity) => {
        phase.value = 'native';
        session = await invoke<Session>('accept_account_session', { expiresAt: Math.floor(expiresAt / 1000), vpnAuth, accessToken: identity.accessToken, accountId: identity.accountId });
      });
      this.restoration = Promise.resolve();
      if (!session) throw new Error();
      void this.bootstrap().then(state => state.selectedServerId ? this.prepareServer(state.selectedServerId) : undefined).catch(() => {});
      return session;
    }
    catch (error) {
      await this.identity.logout().catch(() => {});
      if (phase.value === 'native') await invoke('logout').catch(() => {});
      throw sessionFailure(error, phase.value);
    }
  }
  login(email: string, password: string) { return this.authenticate('login', email, password); }
  register(email: string, password: string) { return this.authenticate('register', email, password); }
  loginAccount(accountNumber: string) { return this.authenticate('account', accountNumber, ''); }
  async current() {
    const account = await this.identity.currentAccount().catch(error => this.rejected(error));
    if (vpnAccess(account)?.active) {
      // A credential outage must not hide a successful subscription refresh.
      // Connect retries setup explicitly; an applied code is never redeemed again.
      await this.ensureVpnAuth().catch(error => { if (error instanceof SessionRejected) return this.rejected(error); });
    }
    return account;
  }
  async activateCode(code: string) {
    await this.identity.activateCode(code).catch(error => this.rejected(error));
    await this.current().catch(error => { if (error instanceof SessionRejected) return this.rejected(error); });
  }
  private ensureVpnAuth() {
    return this.identity.ensureVpnAuth(async expectedToken => !await invoke<boolean>('has_vpn_auth', { expectedToken }),
      async (vpnAuth, expectedToken) => { await invoke('accept_vpn_auth', { vpnAuth, expectedToken }); });
  }
  async cached() {
    await this.restoreIdentity();
    const memory = this.identity.cachedAccount();
    if (memory) return memory;
    try { return this.identity.restoreAccountCache(await invoke<unknown>('read_cached_account')); } catch { return null; }
  }
  subscribe(changed: (snapshot: DesktopSnapshot) => void) {
    return listen<unknown>('desktop-changed', event => changed(decodeSnapshot(event.payload)));
  }
  showMain() { return invoke<void>('show_main'); }
  async selectLocation(serverId: string) { await invoke<void>('select_location', { serverId }); }
  private async prepareServer(serverId: string, isCurrent = () => true) {
    const config = await this.identity.configuration(serverId).catch(error => this.rejected(error));
    if (!isCurrent()) throw new DOMException('Connection cancelled', 'AbortError');
    const locationName = catalog.find(server => server.id === serverId)?.name;
    await invoke<void>('prepare_vpn_configuration', { serverId, config, locationName });
  }
  async prepareRotation(serverId: string, locationName: string) {
    const config = await this.identity.configuration(serverId).catch(error => this.rejected(error));
    await invoke<void>('prepare_vpn_configuration', { serverId, config, locationName, rotation: true });
  }
  onNativeConnectionState(callback: (id: string | null) => void) {
    return listen<string | null>('native-connection-state', event => callback(event.payload));
  }
  onAccountRefresh(callback: (reason: 'resume' | 'periodic') => void) {
    return listen<unknown>('account-refresh-due', event => {
      if (event.payload === 'resume' || event.payload === 'periodic') callback(event.payload);
    });
  }
  showLocations() { return invoke<void>('show_locations'); }
  onShowLocations(callback: () => void) { return listen('show-locations', callback); }
  hideTray() { return invoke<void>('hide_tray'); }
  quit() { return invoke<void>('quit_preview'); }
  async bootstrap(): Promise<DesktopSnapshot> { await this.restoreIdentity(); return decodeSnapshot(await invoke<unknown>('bootstrap')); }
  openExternal(url: string) { return invoke<void>('open_stellar_link', { url }); }
  async connect(serverId: string) {
    const deadline = new ConnectionDeadline();
    const attempt = { controller: new AbortController(), native: false };
    this.attempt = attempt;
    let expired = false;
    const timer = setTimeout(() => { expired = true; attempt.controller.abort(); }, deadline.remaining());
    let rejectCancellation: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = () => reject(new DOMException('Connection cancelled', 'AbortError'));
      attempt.controller.signal.addEventListener('abort', rejectCancellation, { once: true });
    });
    const work = async () => {
      await this.identity.verifyVpnAccess();
      if (attempt.controller.signal.aborted) throw new DOMException('Connection cancelled', 'AbortError');
      await this.ensureVpnAuth().catch(error => this.rejected(error));
      if (attempt.controller.signal.aborted) throw new DOMException('Connection cancelled', 'AbortError');
      if (this.identity.active) await this.prepareServer(serverId, () => !attempt.controller.signal.aborted);
      if (attempt.controller.signal.aborted) throw new DOMException('Connection cancelled', 'AbortError');
      attempt.native = true;
      return invoke<ConnectionSnapshot>('connect_preview', { serverId, timeoutMs: deadline.remaining() });
    };
    try { return await Promise.race([work(), cancelled]); }
    catch (error) {
      if (expired) {
        // Do not expose a disconnected UI until the native stop has been confirmed.
        await this.cancelConnect();
        throw new Error('Connection timed out after 30 seconds. Please try again.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      attempt.controller.signal.removeEventListener('abort', rejectCancellation);
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  async cancelConnect(): Promise<ConnectionSnapshot> {
    const attempt = this.attempt;
    attempt?.controller.abort();
    if (attempt && !attempt.native) return (await this.bootstrap()).connection;
    if (attempt) return attempt.cancellation ??= invoke<ConnectionSnapshot>('cancel_connection');
    return invoke<ConnectionSnapshot>('cancel_connection');
  }
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
