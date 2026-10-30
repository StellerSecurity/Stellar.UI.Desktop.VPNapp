export type Screen = 'booting' | 'auth' | 'onboarding' | 'app';
export function screenAfterSessionUpdate(current: Screen, session: { authenticated: boolean; onboardingComplete: boolean }): Screen {
  if (!session.authenticated) return 'auth';
  // A telemetry refresh must not dismiss a guide the user deliberately opened.
  if (current === 'onboarding' || !session.onboardingComplete) return 'onboarding';
  return 'app';
}
