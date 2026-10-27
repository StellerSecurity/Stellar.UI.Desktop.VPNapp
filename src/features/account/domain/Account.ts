export interface Account {
  id: string;
  deviceName: string;
  deviceLimit: number;
  devicesUsed: number;
  expiresAt: string;
  periodDays: number;
}
export interface AccountRepository { current(): Promise<Account> }
export function daysRemaining(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 86_400_000)) : 0;
}
