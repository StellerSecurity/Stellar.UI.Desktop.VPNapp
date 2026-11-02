import test from 'node:test';
import assert from 'node:assert/strict';
import { StagingServerRepository, STAGING_CATALOG_URL, decodeStagingCatalog } from '../src/infrastructure/catalog/StagingServerRepository.ts';
const row = {id:'dk-1',name:'Denmark – Copenhagen',country_code:'DK',coordinates:{latitude:55.6761,longitude:12.5683}};
const envelope = (data: unknown = [row]) => ({data,meta:{api_version:'v2',mode:'fixture'}});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('staging catalog maps only validated v2 fixture DTOs to domain models', () => {
  const result=decodeStagingCatalog(envelope());
  assert.deepEqual(result[0],{id:'dk-1',country:'Denmark',countryCode:'DK',city:'Copenhagen',flag:'🇩🇰',lat:55.6761,lon:12.5683});
  for(const invalid of [[],{},envelope([]),envelope([row,row]),envelope([{...row,coordinates:{latitude:91,longitude:12}}]),{...envelope(),meta:{api_version:'v1',mode:'fixture'}},{...envelope(),meta:{api_version:'v2',mode:'live'}},envelope(Array(1001).fill(row))]) assert.throws(()=>decodeStagingCatalog(invalid));
});
test('repository calls only staging, without credentials, cache or redirects', async () => {
  let calls=0;
  const repo=new StagingServerRepository(async(url,options)=>{
    calls++;
    assert.equal(url,STAGING_CATALOG_URL);
    assert.equal(options?.credentials,'omit'); assert.equal(options?.redirect,'error'); assert.equal(options?.cache,'no-store');
    assert.deepEqual(options?.headers,{Accept:'application/json'});
    return json(envelope());
  });
  assert.equal((await repo.list()).length,1);assert.equal(calls,1);
});
test('network, HTTP, malformed and oversized responses fail without bundled fallback or leaked details', async () => {
  for(const reply of [()=>Promise.reject(new Error('secret upstream detail')),()=>json({error:'secret upstream detail'},503),()=>new Response('<html>secret upstream detail</html>'),()=>json({}),()=>new Response('{bad',{headers:{'Content-Type':'application/json'}}),()=>json('x'.repeat(512*1024))]){
    const repo=new StagingServerRepository(async()=>reply());
    await assert.rejects(repo.list(),error=>error instanceof Error&&error.message.includes('Could not load test locations')&&!error.message.includes('secret upstream detail'));
  }
});
test('unmount cancellation reaches the transport and cleans up', async () => {
  const controller=new AbortController();
  const repo=new StagingServerRepository(async(_url,options)=>new Promise((_resolve,reject)=>{
    options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }));
  const result=repo.list(controller.signal);controller.abort();
  await assert.rejects(result,/Could not load test locations/);
});
test('a failed initial catalog request can be retried without caching an empty list', async () => {
  let calls = 0;
  const repo = new StagingServerRepository(async () => {
    if (++calls === 1) throw new Error('temporary network failure');
    return json(envelope());
  });
  assert.equal((await repo.list())[0].id, 'dk-1');
  assert.equal(calls, 2);
});

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test('the last successful catalog is available immediately after restarting, without a network call', async () => {
  const disk = storage();
  const first = new StagingServerRepository(async () => json(envelope()), disk);
  await first.list();
  let calls = 0;
  const restarted = new StagingServerRepository(async () => { calls++; throw new Error('offline'); }, disk);
  assert.equal(restarted.cached()[0].id, 'dk-1');
  assert.equal(calls, 0);
  await assert.rejects(restarted.list());
  assert.equal(restarted.cached()[0].id, 'dk-1');
});
test('cache stores only public location fields, never upstream configs or credentials', async () => {
  const disk = storage();
  const repo = new StagingServerRepository(async () => json(envelope([{ ...row, config: 'private-config', password: 'private-password', access_token: 'private-token' }])), disk);
  await repo.list();
  const content = [...disk.values.values()][0];
  assert.ok(!/private-|password|access_token|config"/.test(content));
  const changed = repo.cached(); changed[0].id = 'tampered';
  assert.equal(repo.cached()[0].id, 'dk-1');
});
test('a bad or empty refresh never replaces the known catalog, but a successful refresh does', async () => {
  const disk = storage(); let current: unknown = envelope();
  const repo = new StagingServerRepository(async () => json(current), disk);
  await repo.list();
  for (const invalid of [envelope([]), {}, envelope([row, row])]) {
    current = invalid; await assert.rejects(repo.list()); assert.equal(repo.cached()[0].id, 'dk-1');
  }
  current = envelope([{ ...row, id: 'de-1', name: 'Germany – Frankfurt', country_code: 'DE' }]);
  await repo.list(); assert.deepEqual(repo.cached().map(server => server.id), ['de-1']);
});
test('malformed, oversized and wrong-origin caches are not trusted', () => {
  for (const content of ['{bad', 'x'.repeat(512 * 1024 + 1), JSON.stringify({ version: 1, source: 'https://wrong.example/servers', servers: [row] }),
    JSON.stringify({ version: 1, source: STAGING_CATALOG_URL, servers: [{ id: '../bad', name: 'Bad', country: 'DK', lat: 0, lon: 0 }] })]) {
    const repo = new StagingServerRepository(async () => json(envelope()), { getItem: () => content, setItem: () => {} });
    assert.deepEqual(repo.cached(), []);
  }
});
test('unavailable local storage does not break a successful live list or its memory cache', async () => {
  const repo = new StagingServerRepository(async () => json(envelope()), { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } });
  assert.equal((await repo.list()).length, 1); assert.equal(repo.cached()[0].id, 'dk-1');
});
