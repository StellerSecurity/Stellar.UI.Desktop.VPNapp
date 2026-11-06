import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRememberedSession } from '../src/infrastructure/auth/RememberedSession.ts';
import { sessionFailure } from '../src/infrastructure/auth/SessionFailure.ts';

test('failed or missing vault persistence cannot produce a successful login', () => {
  for (const remembered of [false, undefined, null, 'true']) {
    assert.throws(() => requireRememberedSession({ remembered } as { remembered: boolean }), error => {
      assert.match(sessionFailure(error, 'native').message, /secure session storage/);
      return true;
    });
  }
});

test('a durable session preserves the native session details', () => {
  const session = { remembered: true, authenticated: true, onboardingComplete: false };
  assert.equal(requireRememberedSession(session), session);
});
