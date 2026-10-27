import type { DesktopSnapshot } from '../../contracts/desktop';
/** Treat IPC payloads as wire DTOs, not trusted casts. Detect incompatible native/frontend builds early. */
export function decodeSnapshot(value: unknown): DesktopSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid desktop response.');
  const source = value as Record<string, unknown>;
  if (source.contractVersion !== 1 || !['native-preview', 'browser-preview'].includes(String(source.runtime))) throw new Error('Unsupported desktop protocol. Update the app.');
  const connection = source.connection as Record<string, unknown> | undefined;
  const session = source.session as Record<string, unknown> | undefined;
  const settings = source.settings as Record<string, unknown> | undefined;
  if (source.selectedServerId !== undefined && (typeof source.selectedServerId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(source.selectedServerId))) throw new Error('Invalid selected server.');
  if (!connection || !['connected', 'disconnected'].includes(String(connection.status))
    || !(connection.serverId === null || typeof connection.serverId === 'string')
    || !(connection.connectedAt === null || typeof connection.connectedAt === 'number' && Number.isFinite(connection.connectedAt))
    || !session || typeof session.authenticated !== 'boolean' || typeof session.onboardingComplete !== 'boolean'
    || !settings || typeof settings.language !== 'string'
    || !['autoConnect', 'killSwitch', 'autoRotate', 'notifications', 'menuBar'].every(key => typeof settings[key] === 'boolean')) throw new Error('Invalid desktop response.');
  return value as DesktopSnapshot;
}
