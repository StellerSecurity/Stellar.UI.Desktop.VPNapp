/** Only first-party, controlled messages cross into the UI; never raw IPC text. */
const nativeMessages: Record<string, string> = {
  session_storage_unavailable: 'Couldn’t access secure session storage. Please try again.',
  invalid_session: 'Your session has expired. Please log in again.',
  invalid_vpn_auth: 'VPN authentication is unavailable. Please log in again.',
  preferences_io: 'Couldn’t save app preferences. Please check your user-folder permissions.',
  state_unavailable: 'The app could not open your session. Please restart Stellar VPN.',
  desktop_unavailable: 'The app could not open your session. Please restart Stellar VPN.',
};
export function sessionFailure(error: unknown, phase: 'identity' | 'native'): Error {
  if (phase === 'identity' && error instanceof Error) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && nativeMessages[error.code]) {
    return new Error(nativeMessages[error.code]);
  }
  return new Error('Could not open your session. Please restart Stellar VPN and try again.');
}
