import type { Session } from '../../../contracts/desktop';
export type AuthView = 'intro' | 'login' | 'register' | 'account';
export interface SessionPort {
  login(email: string, password: string): Promise<Session>;
  register(email: string, password: string): Promise<Session>;
  loginAccount(accountNumber: string): Promise<Session>;
  logout(): Promise<Session>;
  completeOnboarding(): Promise<Session>;
}
export function validateAuth(view: AuthView, fields: Record<string, string>): string | null {
  if (['login', 'register'].includes(view) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email || '')) return 'Enter a valid email address.';
  if (view === 'login' && !fields.password) return 'Enter your password.';
  if (view === 'register' && (fields.password || '').length < 6) return 'Use at least 6 characters.';
  if (view === 'account' && (!/^[0-9 ]+$/.test(fields.account || '') || (fields.account || '').replace(/ /g, '').length !== 16)) return 'Enter all 16 digits.';
  return null;
}
/** Account identifiers are exactly 16 ASCII digits; never accept letters from paste or IME. */
export function accountDigits(value: string): string { return value.replace(/[^0-9]/g, '').slice(0, 16); }
