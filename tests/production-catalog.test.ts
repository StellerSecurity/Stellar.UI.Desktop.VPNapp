import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionServerRepository } from '../src/infrastructure/catalog/ProductionServerRepository.ts';
import { PRODUCTION_API_BASE } from '../src/infrastructure/config/Production.ts';

const row = { id: 'ch-1', name: 'Switzerland – Zurich', country_code: 'CH', coordinates: { latitude: 47.37, longitude: 8.54 } };
const response = (mode: string) => new Response(JSON.stringify({ data: [row], meta: { api_version: 'v2', mode } }), { headers: { 'Content-Type': 'application/json' } });

test('release catalog uses production, omits credentials and accepts its production envelope', async () => {
  const repo = new ProductionServerRepository(async (url, options) => {
    assert.equal(url, `${PRODUCTION_API_BASE}/servers`);
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    return response('production');
  });
  assert.equal((await repo.list())[0].id, 'ch-1');
});

test('release catalog rejects fixture responses and ignores a cached staging catalog', async () => {
  const storage = { getItem: () => JSON.stringify({ version: 1, source: 'https://stellar-desktop-vpn-staging-premium-dtfhc6g5hfhch2gs.westeurope-01.azurewebsites.net/api/v2/servers', servers: [{ id: 'test-1', name: 'Test', country: 'CH', lat: 47, lon: 8 }] }), setItem: () => {} };
  const repo = new ProductionServerRepository(async () => response('fixture'), storage);
  assert.deepEqual(repo.cached(), []);
  await assert.rejects(repo.list(), /Could not reach Stellar/);
  assert.deepEqual(repo.cached(), []);
});
