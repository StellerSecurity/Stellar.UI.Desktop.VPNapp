// Data-only review: never import or execute the decoded Python.
import fs from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const workflow=fs.readFileSync('.security-review/user-api/.github/workflows/stellar-commit-trigger.yml','utf8');
const blocks=workflow.split(/(?=      - name: Prepare reviewed commit collector chunk 1\n)/).slice(1);
const hash=x=>createHash('sha256').update(x).digest('hex');
const reports=[];
for(const [i,block] of blocks.entries()){
 const chunks=[...block.matchAll(/chunk = base64\.b64decode\('([A-Za-z0-9+/=]+)'/g)].map(m=>Buffer.from(m[1],'base64'));
 const packed=Buffer.concat(chunks),raw=inflateSync(packed,{maxOutputLength:140000});
 if(hash(packed)!=='cdf7fe5ab551740318c48076b4d47645dc2be788ec1d0dd4af308543dafd0248'||hash(raw)!=='9c3cffad2daf0313baf993e9028fa277a5a775921270201f52da92a411503e42')throw Error('Payload hash mismatch');
 fs.writeFileSync(`.security-review/user-api-collector-${i}.txt`,raw);
 const lines=raw.toString('utf8').split('\n');
 reports.push({role:i,bytes:raw.length,sha256:hash(raw),imports:lines.filter(l=>/^(import |from )/.test(l)),urls:[...new Set([...raw.toString().matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0]))],capabilities:lines.flatMap((line,n)=>/subprocess|os\.system|eval\(|exec\(|urlopen|Authorization|GITHUB_TOKEN|PUSHOVER|\.ssh|\.aws|\.azure|launchctl|runpy/.test(line)?[{line:n+1,text:line.trim().slice(0,220)}]:[])});
}
fs.writeFileSync('.security-review/user-api-workflow-static.json',JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports[0],null,2));
