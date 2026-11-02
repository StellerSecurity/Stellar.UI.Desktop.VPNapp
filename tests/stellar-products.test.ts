import test from 'node:test';
import assert from 'node:assert/strict';
import { stellarProducts } from '../src/features/account/domain/StellarProducts.ts';
test('the account directory contains exactly the five requested public product links', () => {
  assert.deepEqual(stellarProducts.map(product => product.name), ['Stellar Notes', 'Stellar Phone', 'Stellar eSIM', 'Stellar Secret', 'Stellar Antivirus']);
  assert.equal(new Set(stellarProducts.map(product => product.url)).size, 5);
  for (const product of stellarProducts) {
    const url = new URL(product.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.ok(['stellarsecurity.com', 'stellaresim.com', 'stellarsecret.io'].includes(url.hostname));
  }
});
