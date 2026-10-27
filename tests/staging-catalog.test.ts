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
