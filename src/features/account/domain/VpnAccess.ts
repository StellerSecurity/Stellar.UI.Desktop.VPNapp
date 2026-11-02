import type { Account } from './Account.ts';
export interface VpnAccess { active: boolean; expiresAt: number | null }
/** A cached display value must never dismiss an access denial. */
export function subscriptionErrorResolved(account: Account | null, kind: 'subscription' | null, now = Date.now()): boolean {
  return kind === 'subscription' && !!account && !account.cached && vpnAccess(account, now)?.active === true;
}
/** Only a fresh, explicit subscription result may grant or revoke access. */
export function vpnAccess(account: Account, now = Date.now()): VpnAccess | null {
  if (account.subscriptionState === 'unavailable') return null;
  const sub = account.subscription;
  const expiry = sub?.expiresAt ? Date.parse(sub.expiresAt) : null;
  return { active: !!sub && ['active', 'trial'].includes(sub.status) && (expiry === null || expiry > now), expiresAt: expiry === null ? null : Math.max(0, Math.floor(expiry / 1000)) };
}
export class SubscriptionRequired extends Error {
  readonly code = 'subscription_required';
  constructor() { super('An active VPN subscription is required.'); }
}
export function subscriptionRequired(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'subscription_required'; }
