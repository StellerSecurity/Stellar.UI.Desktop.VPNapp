/** Versioned, serializable wire contract. Keep in sync with stellar-core::model. */
export type ConnectionStatus = 'disconnected' | 'connected';
export interface ConnectionSnapshot {
  status: ConnectionStatus;
  serverId: string | null;
  connectedAt: number | null;
}
export interface Settings {
  autoConnect: boolean;
  killSwitch: boolean;
  autoRotate: boolean;
  notifications: boolean;
  menuBar: boolean;
  language: string;
}
export interface Session { authenticated: boolean; onboardingComplete: boolean; revocationPending?: boolean }
export interface DesktopSnapshot {
  contractVersion: 1;
  selectedServerId?: string;
  runtime: 'native-preview' | 'browser-preview';
  connection: ConnectionSnapshot;
  settings: Settings;
  session: Session;
}
export interface DesktopError { code: string; message: string }
export const defaultSettings: Readonly<Settings> = {
  autoConnect: false, killSwitch: true, autoRotate: false,
  notifications: true, menuBar: true, language: 'English'
};
