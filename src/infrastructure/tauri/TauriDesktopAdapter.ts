import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DesktopPort } from '../../application/ports/DesktopPort';
import type { ConnectionSnapshot, DesktopSnapshot, Session, Settings } from '../../contracts/desktop';
import { decodeSnapshot } from './decodeSnapshot';
import { HttpIdentityClient, SessionChanged, SessionRejected, type RememberedIdentity } from '../auth/HttpIdentityClient';
import { sessionFailure } from '../auth/SessionFailure';
import { requireRememberedSession } from '../auth/RememberedSession';
import { SessionRestoration } from '../auth/SessionRestoration';
import catalog from '../../../assets/servers.json';
import { ConnectionDeadline } from '../../application/ConnectionDeadline';
import { vpnAccess } from '../../features/account/domain/VpnAccess';

/** Only this adapter knows the IPC command names or Tauri APIs. */
export class TauriDesktopAdapter implements DesktopPort {
  private identity = new HttpIdentityClient(undefined, async (accountData, expectedToken) => { await invoke('write_cached_account', { accountData, expectedToken }); }, async (access, expectedToken) => { await invoke('update_subscription_access', { access, expectedToken }); }, async (identity, expectedToken) => {
    await invoke('renew_account_session', { expectedToken, accessToken: identity.accessToken, accountId: identity.accountId, expiresAt: Math.floor(identity.expiresAt / 1000), renewalToken: identity.renewalToken ?? null });
  });
  private restoration = new SessionRestoration();
  private nativeReadRevision = 0;
  private revocationSweepAfter = 0;
  private revocationSweep?: Promise<void>;
  private sweepRevocations() {
    if (this.revocationSweep || Date.now() < this.revocationSweepAfter) return;
    this.revocationSweepAfter = Date.now() + 60_000;
    const pending = (async () => {
      const roots = await invoke<string[]>('pending_session_revocations');
      for (const root of roots.slice(0, 4)) {
        await this.identity.revokeRememberedCredential(root);
        await invoke('acknowledge_session_revocation', { sessionId: root.split('|')[0] });
      }
    })();
    this.revocationSweep = pending;
    void pending.catch(() => {}).finally(() => { if (this.revocationSweep === pending) this.revocationSweep = undefined; });
  }
  private async synchronizeIdentity() {
    const revision = ++this.nativeReadRevision;
    const saved = await invoke<unknown>('peek_account_session');
    if (revision === this.nativeReadRevision) this.identity.synchronize(saved);
  }
  private withIdentity(snapshot: DesktopSnapshot): DesktopSnapshot {
    return { ...snapshot, session: { ...snapshot.session, identityRevision: this.identity.identityRevision } };
  }
  private attempt?: { controller: AbortController; native: boolean; cancellation?: Promise<ConnectionSnapshot> };
  private async rejected(error: unknown): Promise<never> {
    if (error instanceof SessionRejected && error.sessionId) await invoke('logout', { expectedSessionId: error.sessionId }).catch(() => {});
    throw error;
  }
  private restoreIdentity() {
    return this.restoration.run(async isCurrent => {
      // A locked/denied vault is not an absent session. Keep startup retryable
      // instead of silently displaying a login form or attempting migration.
      const saved = await invoke<unknown>('restore_account_session')
        .catch(error => { throw sessionFailure(error, 'native'); });
      if (!isCurrent()) return;
      try {
        if (saved) {
          this.identity.restore(saved);

          // The unexpired local session opens immediately. Verify revocation in
          // the background; a network outage must not erase a valid saved login.
          void this.identity.verifyRestoredSession().then(async () => {
            if ((saved as { migrationPending?: boolean }).migrationPending === true) {
              await this.finishLegacy((saved as RememberedIdentity).accessToken).catch(() => {});
            }
          }).catch(error => {
            if (error instanceof SessionRejected) void this.rejected(error).catch(() => {});
          });
        } else {
          const candidate = await invoke<{ storeToken: string | null } | null>('legacy_login_candidate');
          if (!isCurrent() || !candidate) return;
          // Only these known old-app keys; never scan a browser profile or read stored passwords.
          const token = candidate.storeToken ?? this.legacyBrowserToken();
          if (!token) return;
          await this.identity.migrateLegacy(token, async identity => {
            const accepted = await invoke<{ remembered: boolean }>('accept_account_session', {
              expiresAt: Math.floor(identity.expiresAt / 1000), vpnAuth: null,
              accessToken: identity.accessToken, accountId: identity.accountId, legacyToken: token,
            });
            if (!accepted.remembered) throw new Error('Migration storage unavailable.');
            // Cleanup failures do not log out a successfully migrated account. The vault retains a retry receipt.
            await this.finishLegacy(identity.accessToken).catch(() => {});
          });
        }
      } catch (error) {
        // Optional legacy migration may fail without preventing ordinary login.
        if (saved) throw error;
      }
    });
  }
  private legacyBrowserToken(): string | null {
    try { return localStorage.getItem('stellar_vpn_bearer_token'); } catch { return null; }
  }
  private async finishLegacy(expectedToken: string): Promise<void> {
    const old = await invoke<string | null>('finish_legacy_login', { expectedToken });
    if (!old) return;
    try {
      if (localStorage.getItem('stellar_vpn_bearer_token') !== old) return;
      for (const key of ['stellar_vpn_bearer_token', 'stellar_vpn_username', 'stellar_vpn_password', 'stellar_vpn_account_number', 'stellar_vpn_device_name']) localStorage.removeItem(key);
    } catch { /* A blocked legacy WebStorage never invalidates the protected replacement session. */ }
  }
  private async authenticate(operation: 'login' | 'register' | 'account', email: string, password: string) {
    let session: Session | undefined;
    const phase: { value: 'identity' | 'native' } = { value: 'identity' };
    try {
      await this.identity.authenticate(operation, email, password, async (expiresAt, vpnAuth, identity) => {
        phase.value = 'native';
        session = requireRememberedSession(await invoke<Session & { remembered: boolean }>('accept_account_session', { expiresAt: Math.floor(expiresAt / 1000), vpnAuth, accessToken: identity.accessToken, accountId: identity.accountId, renewalToken: identity.renewalToken ?? null }));
      });
      this.restoration.complete();
      if (!session) throw new Error();
      void this.bootstrap().then(state => state.selectedServerId ? this.prepareServer(state.selectedServerId) : undefined).catch(() => {});
      return { ...session, identityRevision: this.identity.identityRevision };
    }
    catch (error) {
      if (error instanceof SessionChanged) throw error;
      await this.identity.logout().catch(() => {});
      if (phase.value === 'native') await invoke('logout').catch(() => {});
      throw sessionFailure(error, phase.value);
    }
  }
  login(email: string, password: string) { return this.authenticate('login', email, password); }
  register(email: string, password: string) { return this.authenticate('register', email, password); }
  loginAccount(accountNumber: string) { return this.authenticate('account', accountNumber, ''); }
  createAnonymousAccount() { return this.identity.createAnonymousAccount(); }
  async listDeviceSessions(after?: string) {
    await this.synchronizeIdentity();
    return this.identity.listDeviceSessions(after).catch(error => this.rejected(error));
  }
  async revokeDeviceSession(id: string) {
    await this.synchronizeIdentity();
    return this.identity.revokeDeviceSession(id).catch(error => this.rejected(error));
  }
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
    let revision = 0;
    return listen<unknown>('desktop-changed', event => {
      const current = ++revision;
      void this.synchronizeIdentity().then(() => {
        if (current === revision) changed(this.withIdentity(decodeSnapshot(event.payload)));
      }).catch(() => {});
    });
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
  async bootstrap(): Promise<DesktopSnapshot> { await this.restoreIdentity(); this.sweepRevocations(); await this.synchronizeIdentity(); await this.identity.renewSession().catch(error => { if (error instanceof SessionRejected) return this.rejected(error); }); return this.withIdentity(decodeSnapshot(await invoke<unknown>('bootstrap'))); }
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
    const expectedSessionId = this.identity.sessionId;
    if (!expectedSessionId) throw new Error('The action could not be completed. Please try again.');
    // Never discard the only revocation credential if the vault cannot queue it.
    await invoke('queue_session_revocation', { expectedSessionId });
    try {
      await this.identity.logout(expectedSessionId);
      if (expectedSessionId) await invoke('acknowledge_session_revocation', { sessionId: expectedSessionId }).catch(() => {});
    } catch { failed = true; }
    const session = await invoke<Session>('logout', { expectedSessionId: expectedSessionId ?? null });
    await this.synchronizeIdentity();
    return { ...session, identityRevision: this.identity.identityRevision, ...(failed ? { revocationPending: true } : {}) };
  }
  async completeOnboarding() { return { ...await invoke<Session>('complete_onboarding'), identityRevision: this.identity.identityRevision }; }
}
