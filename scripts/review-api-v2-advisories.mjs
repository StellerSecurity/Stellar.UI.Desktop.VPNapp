// Reads public GitHub Advisory Database JSON. No credentials, package archives or execution.
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-plan.json', 'utf8'));
const report = {timestamp:new Date().toISOString(),packages:plan.packages.map(({name,version})=>({name,version})),results:{}};
for (const type of ['reviewed','malware','unreviewed']) {
 const url = new URL('https://api.github.com/advisories');
 url.searchParams.set('ecosystem','composer'); url.searchParams.set('type',type); url.searchParams.set('per_page','100');
 url.searchParams.set('affects',plan.packages.map(p=>`${p.name}@${p.version.replace(/^v/,'')}`).join(','));
 let next = url.href; const advisories=[];
 while(next) {
  const u=new URL(next);
  if(u.hostname!=='api.github.com'||u.pathname!=='/advisories') throw new Error('Unexpected advisory origin');
  const res=await fetch(u,{headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!res.ok) throw new Error(`GitHub advisory HTTP ${res.status}`);
  advisories.push(...await res.json());
  next=res.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1]||null;
 }
 report.results[type]=advisories;
}
fs.writeFileSync('.security-review/api-v2-github-advisories.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({packages:report.packages.length,matches:Object.fromEntries(Object.entries(report.results).map(([type,items])=>[type,items.map(a=>({id:a.ghsa_id,summary:a.summary,withdrawn:a.withdrawn_at,url:a.html_url}))]))}));
