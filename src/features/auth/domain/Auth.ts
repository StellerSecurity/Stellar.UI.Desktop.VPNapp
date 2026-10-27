import type { Session } from '../../../contracts/desktop';
export type AuthView = 'intro' | 'login' | 'register' | 'account' | 'forgot' | 'otp' | 'reset';
export interface SessionPort {
  login(email: string, password: string): Promise<Session>;
  register(email: string, password: string): Promise<Session>;
  logout(): Promise<Session>;
  completeOnboarding(): Promise<Session>;
}
export function validateAuth(view: AuthView, fields: Record<string, string>): string | null {
  if (['login', 'register', 'forgot'].includes(view) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email || '')) return 'Enter a valid email address.';
  if (view === 'login' && !fields.password) return 'Enter your password.';
  if (['register', 'reset'].includes(view) && (fields.password || '').length < 12) return 'Use at least 12 characters.';
  if (view === 'reset' && fields.password !== fields.confirm) return 'Passwords do not match.';
  if (view === 'account' && (fields.account || '').replace(/\D/g, '').length !== 16) return 'Enter all 16 digits.';
  if (view === 'otp' && !/^\d{4}$/.test(fields.code || '')) return 'Enter the complete four-digit code.';
  return null;
}
