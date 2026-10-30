import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAfterSessionUpdate } from '../src/app/SessionScreen.ts';
test('telemetry updates never dismiss an explicitly opened welcome guide', () => {
  const session = { authenticated: true, onboardingComplete: true };
  assert.equal(screenAfterSessionUpdate('onboarding', session), 'onboarding');
  assert.equal(screenAfterSessionUpdate('app', session), 'app');
});
test('expired sessions still return to authentication and first-time onboarding is required', () => {
  assert.equal(screenAfterSessionUpdate('onboarding', { authenticated: false, onboardingComplete: true }), 'auth');
  assert.equal(screenAfterSessionUpdate('app', { authenticated: true, onboardingComplete: false }), 'onboarding');
});
