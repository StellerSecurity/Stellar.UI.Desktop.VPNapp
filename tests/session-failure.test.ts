import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFailure } from '../src/infrastructure/auth/SessionFailure.ts';
test('identity failures keep their controlled message rather than a misleading native-session error', () => {
  assert.equal(sessionFailure(new Error('Email or password is incorrect.'), 'identity').message, 'Email or password is incorrect.');
});
test('native session errors expose only allowlisted messages and never raw IPC details', () => {
  assert.match(sessionFailure({ code: 'session_storage_unavailable', message: 'private' }, 'native').message, /secure session storage/);
  assert.ok(!sessionFailure({ code: 'unknown', message: 'secret token' }, 'native').message.includes('secret'));
  assert.ok(!sessionFailure('secret token', 'native').message.includes('secret'));
});
