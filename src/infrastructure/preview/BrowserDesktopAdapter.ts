import type { DesktopPort } from '../../application/ports/DesktopPort';
import { defaultSettings, type DesktopSnapshot, type Settings } from '../../contracts/desktop';
import { BrowserPreferences } from '../persistence/BrowserPreferences';
import { settingKeys } from '../../features/settings/domain/Settings';
import { HttpIdentityClient } from '../auth/HttpIdentityClient';
import { stellarProducts } from '../../features/account/domain/StellarProducts';

export class BrowserDesktopAdapter implements DesktopPort {
  private identity = new HttpIdentityClient();
  private storage = new BrowserPreferences();
  private state: DesktopSnapshot;
  constructor() {
    const settings = { ...defaultSettings };
    for (const [legacy, key] of Object.entries(settingKeys)) settings[key] = this.storage.read(legacy, settings[key]) === true;
    settings.language = this.storage.read('language', 'English');
    settings.autoRotate = false;
    settings.killSwitch = false;
    this.state = { contractVersion: 1, runtime: 'browser-preview', settings,
      connection: { status: 'disconnected', serverId: null, connectedAt: null },
      session: { authenticated: false, onboardingComplete: false } };
  }
  private async authenticate(operation: 'login' | 'register' | 'account', email: string, password: string) {
    await this.identity.authenticate(operation, email, password);
    this.state.session = { authenticated: true, onboardingComplete: false };
    return { ...this.state.session };
  }
  login(email: string, password: string) { return this.authenticate('login', email, password); }
  register(email: string, password: string) { return this.authenticate('register', email, password); }
  loginAccount(accountNumber: string) { return this.authenticate('account', accountNumber, ''); }
  current() { return this.identity.currentAccount(); }
  async cached() { return this.identity.cachedAccount(); } // Private display data never enters localStorage.
  async bootstrap() {
    if (this.state.session.authenticated && !this.identity.active) {
      this.state.session = { authenticated: false, onboardingComplete: false };
      this.state.connection = { status: 'disconnected', serverId: null, connectedAt: null };
    }
    return structuredClone(this.state);
  }
  async openExternal(url: string) {
    if (!['https://stellarvpn.org/register', 'https://stellarvpn.org/stellar-relay', 'https://stellarvpn.org/privacy-policy', 'https://stellarvpn.org/terms-and-conditions', 'https://id.stellarsecurity.com/auth/forgot-password', ...stellarProducts.map(product => product.url)].includes(url)) throw new Error('This link is not allowed.');
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  async connect(serverId: string) {
    await this.bootstrap();
    if (!this.state.session.authenticated) throw new Error('Log in before connecting.');
    await this.identity.verifyVpnAccess();
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(serverId)) throw new Error('Invalid server.');
    this.state.connection = { status: 'connected', serverId, connectedAt: Date.now() };
    return { ...this.state.connection };
  }
  async disconnect() {
    this.state.connection = { status: 'disconnected', serverId: null, connectedAt: null };
    return { ...this.state.connection };
  }
  async cancelConnect() { return { ...this.state.connection }; }
  async saveSettings(settings: Settings) {
    if (settings.killSwitch) throw new Error('Kill switch requires the desktop application.');
    if (settings.autoRotate) throw new Error('Auto Rotate is not available yet.');
    this.state.settings = { ...settings };
    for (const [legacy, key] of Object.entries(settingKeys)) this.storage.write(legacy, settings[key]);
    this.storage.write('language', settings.language);
    return { ...settings };
  }
  async logout() {
    let failed = false;
    try { await this.identity.logout(); } catch { failed = true; }
    await this.disconnect();
    this.state.session = { authenticated: false, onboardingComplete: false };
    this.storage.write('authenticated', false);
    this.storage.write('onboarding-complete', false);
    return { ...this.state.session, ...(failed ? { revocationPending: true } : {}) };
  }
  async completeOnboarding() {
    await this.bootstrap();
    if (!this.state.session.authenticated) throw new Error('Log in before continuing.');
    this.state.session.onboardingComplete = true;
    this.storage.write('onboarding-complete', true);
    return { ...this.state.session };
  }
}
