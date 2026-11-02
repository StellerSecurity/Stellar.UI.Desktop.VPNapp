// Enforces the complete reviewed graph before any runtime installation.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
export function verifyRuntimeLock(plan, lock) {
const expected=new Map(plan.packages.map(p=>[p.name,p]));
const errors=[];
if(lock.packages.length!==expected.size || (lock['packages-dev']||[]).length) errors.push('Unapproved package/dev graph');
const seen=new Set();
for(const p of lock.packages){
 const e=expected.get(p.name);
 if(!e || seen.has(p.name)) {errors.push(`Unexpected/duplicate package: ${p.name}`);continue;}
 seen.add(p.name);
 for(const key of ['version','source','autoload','require','extra','type','bin','provide','replace','conflict']) {
  function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));return v;}
  if(JSON.stringify(canonical(p[key]))!==JSON.stringify(canonical(e[key])))errors.push(`Unreviewed ${key}: ${p.name}`);
 }
 if(p.dist?.reference!==e.dist?.reference||p.dist?.url!==e.dist?.url||p.dist?.type!==e.dist?.type)errors.push(`Archive source changed: ${p.name}`);
 if(p.type!=='library')errors.push(`Non-library package: ${p.name}`);
}
for(const name of expected.keys())if(!seen.has(name))errors.push(`Missing package: ${name}`);
if(lock['plugin-api-version']!=='2.9.0')errors.push('Unexpected Composer plugin API marker');
return errors;
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const proposedPath=process.argv[2];
 if(!proposedPath) throw new Error('Pass the proposed composer.lock path');
 const plan=JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-plan.json','utf8'));
 const lock=JSON.parse(fs.readFileSync(proposedPath,'utf8'));
 const errors=verifyRuntimeLock(plan,lock);
 if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
 else console.log(`${plan.packages.length} exact runtime packages verified; install/execution still requires explicit approval.`);
}
