import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRuntimeLock} from '../../scripts/check-api-v2-runtime-lock.mjs';

const pkg={name:'test/library',version:'1.0.0',type:'library',source:{url:'https://github.com/test/library.git',reference:'fixed'},dist:{type:'zip',url:'https://api.github.com/repos/test/library/zipball/fixed',reference:'fixed'},require:{php:'^8.2'},autoload:{'psr-4':{'Test\\':'src/'}}};
const plan={packages:[pkg]};
const lock=()=>({packages:[structuredClone(pkg)],'packages-dev':[],'plugin-api-version':'2.9.0'});
test('v2 runtime accepts exact reviewed tuple',()=>assert.deepEqual(verifyRuntimeLock(plan,lock()),[]));
test('v2 runtime rejects extras, omissions and duplicate packages',()=>{
 for(const packages of [[],[pkg,pkg],[pkg,{...pkg,name:'extra/library'}]]) assert.ok(verifyRuntimeLock(plan,{...lock(),packages}).length);
});
test('v2 runtime rejects changed version, source, archive and autoload',()=>{
 for(const patch of [{version:'1.0.1'},{source:{...pkg.source,reference:'other'}},{dist:{...pkg.dist,url:'https://other.invalid/download'}},{autoload:{files:['payload.php']}}]) {
  const next=lock();Object.assign(next.packages[0],patch);assert.ok(verifyRuntimeLock(plan,next).length);
 }
});
test('v2 runtime rejects plugins, dev dependencies and writer marker changes',()=>{
 const plugin=lock();plugin.packages[0].type='composer-plugin';assert.ok(verifyRuntimeLock(plan,plugin).length);
 const dev=lock();dev['packages-dev']=[pkg];assert.ok(verifyRuntimeLock(plan,dev).length);
 assert.ok(verifyRuntimeLock(plan,{...lock(),'plugin-api-version':'3.0.0'}).length);
});
