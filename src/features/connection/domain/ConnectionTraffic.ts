import type { ConnectionSnapshot } from '../../../contracts/desktop';

export interface TrafficDisplay {
  session: string | null;
  download: number | null;
  upload: number | null;
}
export const emptyTraffic: TrafficDisplay = { session: null, download: null, upload: null };
const validRate = (rate: unknown): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;

/** Missing telemetry is not zero traffic; retain the last measurement only within this tunnel. */
export function connectionTraffic(previous: TrafficDisplay, connection?: ConnectionSnapshot): TrafficDisplay {
  if (connection?.status !== 'connected') return emptyTraffic;
  const session = JSON.stringify([connection.serverId, connection.connectedAt]);
  const sameTunnel = previous.session === session;
  return {
    session,
    download: validRate(connection.downloadMbps) ? connection.downloadMbps : sameTunnel ? previous.download : null,
    upload: validRate(connection.uploadMbps) ? connection.uploadMbps : sameTunnel ? previous.upload : null,
  };
}
export const displayTrafficRate = (rate: number | null, locale = 'en-GB'): string => rate === null ? '—' : new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rate);
