import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseFrontend } from '../scripts/verify-release-frontend.mjs';

test('release frontend matches tracked inputs and output hashes', () => {
  const result = verifyReleaseFrontend();
  assert.equal(result.files, 6);
  assert.match(result.input_sha256, /^[a-f0-9]{64}$/);
});
