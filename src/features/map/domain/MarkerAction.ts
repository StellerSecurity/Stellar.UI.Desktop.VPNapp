import type { ConnectionSnapshot } from '../../../contracts/desktop';

export function markerAction(id: string, availableIds: readonly string[], connection: ConnectionSnapshot | undefined, pending: boolean) {
  if (pending || !availableIds.includes(id)) return 'ignore';
  return connection?.status === 'connected' && connection.serverId === id ? 'select' : 'connect';
}
