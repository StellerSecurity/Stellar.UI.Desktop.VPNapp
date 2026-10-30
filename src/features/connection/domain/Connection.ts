import type { ConnectionSnapshot } from '../../../contracts/desktop';
export type ConnectionView = ConnectionSnapshot & { pending: boolean };
export interface ConnectionPort {
  connect(serverId: string): Promise<ConnectionSnapshot>;
  disconnect(): Promise<ConnectionSnapshot>;
  cancelConnect?(): Promise<ConnectionSnapshot>;
}
export function elapsedTime(connectedAt: number | null, now: number): string {
  const seconds = connectedAt === null ? 0 : Math.max(0, Math.floor((now - connectedAt) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}
