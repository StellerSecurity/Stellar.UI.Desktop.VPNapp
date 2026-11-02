// First-party allowlisted packaging. Never copies credentials, Markdown or caches.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const source=path.resolve('desktop-api');
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'stellar-api-v2-'));
const manifest=[];
const excluded=new Set(['.git','.DS_Store','.env','node_modules','bin']);
function copy(relative){
 const input=path.join(source,relative), stat=fs.lstatSync(input);
 if(stat.isSymbolicLink())throw new Error(`Symlink rejected: ${relative}`);
 const name=path.basename(relative);
 if(excluded.has(name)||/\.md$/i.test(name)||name.startsWith('.env.'))return;
 if(relative.startsWith('bootstrap/cache/')||relative.startsWith('storage/'))return;
 const output=path.join(stage,relative);
 if(stat.isDirectory()){
  fs.mkdirSync(output,{recursive:true});
  for(const child of fs.readdirSync(input).sort())copy(path.join(relative,child));
 }else if(stat.isFile()){
  const data=fs.readFileSync(input);
  if(data.includes(Buffer.from([0])))throw new Error(`Binary rejected: ${relative}`);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.copyFileSync(input,output);
  manifest.push({path:relative,sha256:createHash('sha256').update(data).digest('hex')});
 }else throw new Error(`Unexpected file type: ${relative}`);
}
for(const item of ['app','bootstrap','config','routes','public','resources','fixtures','vendor','deploy','composer.json','composer.lock'])copy(item);
for(const item of ['bootstrap/cache','storage/framework/views'])fs.mkdirSync(path.join(stage,item),{recursive:true});
const zip=path.join(path.dirname(stage),path.basename(stage)+'.zip');
const result=spawnSync('/usr/bin/zip',['-q','-r',zip,'.'],{cwd:stage,stdio:'inherit'});
if(result.status!==0)throw new Error('ZIP failed');
const evidence={stage,zip,files:manifest.length,bytes:fs.statSync(zip).size,sha256:createHash('sha256').update(fs.readFileSync(zip)).digest('hex'),manifest};
fs.writeFileSync('.security-review/api-v2-deployment-package.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({...evidence,manifest:undefined},null,2));
