import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDigits } from '../src/features/auth/domain/Auth.ts';
test('account number input accepts only ASCII digits including pasted text and caps at sixteen', () => {
  assert.equal(accountDigits('24234adsa'), '24234');
  assert.equal(accountDigits('1234 5678-9012\n3456'), '1234567890123456');
  assert.equal(accountDigits('letters１２٣!'), '');
  assert.equal(accountDigits('12345678901234567890'), '1234567890123456');
  assert.equal(accountDigits(''), '');
});
