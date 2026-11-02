import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAfterSessionUpdate } from '../src/app/SessionScreen.ts';
test('telemetry updates never dismiss an explicitly opened welcome guide', () => {
  const session = { authenticated: true, onboardingComplete: true };
  assert.equal(screenAfterSessionUpdate('onboarding', session), 'onboarding');
  assert.equal(screenAfterSessionUpdate('app', session), 'app');
});
test('expired sessions require authentication but the product tour is optional', () => {
  assert.equal(screenAfterSessionUpdate('onboarding', { authenticated: false, onboardingComplete: true }), 'auth');
  assert.equal(screenAfterSessionUpdate('app', { authenticated: true, onboardingComplete: false }), 'app');
});
