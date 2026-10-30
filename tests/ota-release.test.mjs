import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManifest, verifyRelease, stableVersion, PINNED_PUBLIC_KEY } from '../scripts/prepare-ota-manifest.mjs';
const key = 'RWQBAgMEBQYHCNdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea';
const bytes = Buffer.from('Stellar OTA public test vector\n');
const sig = 'untrusted comment: public RFC8032 test fixture only\nRUQBAgMEBQYHCDY7YleM/BoaJQETcaoz7/LSaXi+pr0BiObnu6ILp/M7SN3ZLziwGMqsQPpswsQySr4gmGtg3MkpTIwEiGtViQA=\ntrusted comment: timestamp:1\tfile:test.app.tar.gz\tversion:1.2.3\nV7C6JW+U3OfHf71UzxmBjILdO21Bu5nT8nEhEzSlcueCLhfYGzic+RdOP/Al76ppGP40PPmYWocAdQsTieTsAw==';
test('public release tooling independently verifies signature and signed version', () => {
  assert.equal(Buffer.from(verifyRelease(bytes, sig, '1.2.3', key), 'base64').toString(), sig);
  assert.throws(() => verifyRelease(Buffer.from('tampered'), sig, '1.2.3', key));
  assert.throws(() => verifyRelease(bytes, sig, '9.9.9', key));
  assert.throws(() => verifyRelease(bytes, sig.replace('version:1.2.3', 'version:9.9.9'), '9.9.9', key));
});
test('release manifest can never replace the production trust root with a test key', () => {
  assert.notEqual(PINNED_PUBLIC_KEY, key);
  assert.throws(() => createManifest(bytes, sig, '1.2.3', 'darwin-aarch64'));
  assert.throws(() => createManifest(bytes, sig, '1.2.3', 'windows-x86_64'));
  for (const value of ['v1.0.0', '01.0.0', '1.0.0-beta', '1.0.0+build', '4294967296.0.0']) assert.throws(() => stableVersion(value));
});
