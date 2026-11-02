// First-party, read-only verification before loading any downloaded PHP runtime code.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const plan=JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-plan.json','utf8'));
const review=JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-source.json','utf8'));
const vendor=path.resolve('desktop-api/vendor');
const installed=JSON.parse(fs.readFileSync(path.join(vendor,'composer/installed.json'),'utf8')).packages;
const expected=new Map(plan.packages.map(p=>[p.name,p]));
const errors=[];const checks=[];
if(installed.length!==expected.size)errors.push('Unexpected installed package count');
for(const p of installed){
 const e=expected.get(p.name);
 if(!e||p.version!==e.version||p.source?.reference!==e.source.reference||p.source?.url!==e.source.url)errors.push(`Installed identity mismatch: ${p.name}`);
}
for(const pkg of review.packages){
 const packageRoot=path.join(vendor,pkg.name);
 for(const file of pkg.files.filter(f=>typeof f.source==='string')){
  const candidate=path.resolve(packageRoot,file.path);
  try{
   const actualPath=fs.realpathSync(candidate);
   if(!actualPath.startsWith(packageRoot+path.sep))throw new Error('Source escaped package directory');
   const actual=fs.readFileSync(actualPath,'utf8');
   const hash=text=>createHash('sha256').update(text).digest('hex');
   const expectedHash=hash(file.source),actualHash=hash(actual);
   checks.push({package:pkg.name,path:file.path,expectedHash,actualHash});
   if(actualHash!==expectedHash)errors.push(`Reviewed source differs from installed: ${pkg.name}/${file.path}`);
  }catch(error){errors.push(`${pkg.name}/${file.path}: ${error.message}`);}
 }
}
fs.writeFileSync('.security-review/api-v2-installed-source-check.json',JSON.stringify({timestamp:new Date().toISOString(),packages:installed.length,checks,errors,scope:'Reviewed source samples only; not full-archive attestation'},null,2));
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log(`${installed.length} installed package identities and ${checks.length} reviewed source-file SHA-256 hashes verified. No PHP code loaded.`);
