/** Versioned, serializable wire contract. Keep in sync with stellar-core::model. */
export type ConnectionStatus = 'disconnected' | 'connected';
export interface ConnectionSnapshot {
  trafficBlocked?: boolean;
  status: ConnectionStatus;
  serverId: string | null;
  connectedAt: number | null;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
}
export interface Settings {
  autoConnect: boolean;
  killSwitch: boolean;
  autoRotate: boolean;
  notifications: boolean;
  menuBar: boolean;
  language: string;
}
export interface Session { authenticated: boolean; onboardingComplete: boolean; revocationPending?: boolean; remembered?: boolean }
export interface DesktopSnapshot {
  subscriptionAccess?: { active: boolean; expiresAt: number | null } | null;
  capabilities?: { autoRotate: boolean; killSwitch: boolean };
  contractVersion: 1;
  selectedServerId?: string;
  runtime: 'native-preview' | 'browser-preview';
  connection: ConnectionSnapshot;
  settings: Settings;
  session: Session;
}
export interface DesktopError { code: string; message: string }
export const defaultSettings: Readonly<Settings> = {
  autoConnect: true, killSwitch: false, autoRotate: false,
  notifications: true, menuBar: true, language: 'English'
};
