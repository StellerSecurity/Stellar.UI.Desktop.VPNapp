import type { ConnectionSnapshot } from '../../../contracts/desktop';

/** Selection is intent, never proof of an established tunnel. */
export function mapStatus(connection: ConnectionSnapshot | undefined, pending: boolean) {
  const securedServerId = !pending && connection?.status === 'connected' && connection.serverId
    ? connection.serverId : null;
  return { connected: securedServerId !== null, securedServerId };
}
