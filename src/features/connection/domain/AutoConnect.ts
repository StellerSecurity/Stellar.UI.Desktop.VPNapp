import type { DesktopSnapshot } from '../../../contracts/desktop.ts';

/** Never spend the one startup attempt before identity and catalog are ready. */
export function autoConnectTarget(snapshot: DesktopSnapshot | null, ready: boolean, ids: readonly string[], attempted: boolean, pending: boolean): string | null {
  if (attempted || pending || !ready || !snapshot?.settings.autoConnect || !snapshot.session.authenticated
    || snapshot.subscriptionAccess?.active === false
    || !snapshot.session.onboardingComplete || snapshot.connection.status !== 'disconnected' || snapshot.connection.trafficBlocked) return null;
  const selected = snapshot.selectedServerId;
  return selected && ids.includes(selected) ? selected : null;
}
