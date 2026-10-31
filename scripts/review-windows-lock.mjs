// Read-only registry/advisory requests; never installs, imports or executes crates.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const packages = lock.split('[[package]]').slice(1).filter(s => s.includes('registry+')).map(s => ({
  name: s.match(/^name = "([^"]+)"/m)[1], version: s.match(/^version = "([^"]+)"/m)[1], checksum: s.match(/^checksum = "([a-f0-9]{64})"/m)[1],
}));
const prior = JSON.parse(fs.readFileSync('.security-review/source-review.json', 'utf8')).crates;
const notification = JSON.parse(fs.readFileSync('.security-review/notification-install-review.json', 'utf8')).packages;
const ota = JSON.parse(fs.readFileSync('.security-review/ota-verifier-approval-2026-10-29.json', 'utf8'));
const reviewed = new Set([...prior, ...notification, {name: ota.package, version: ota.version}].map(p => `${p.name}@${p.version}`));
const banned = new Set(['proc-macro1', 'proc-macro-en', 'arrayref', 'internment', 'append-only-vec', 'aovine', 'arone', 'aronenao', 'tinymember', 'tauri-winrt-notifications', 'tauri-win-rt-notification']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = path.join(os.homedir(), '.cargo', 'registry', 'cache');
const registries = fs.readdirSync(cache).map(name => path.join(cache, name));
const report = {
  date: new Date().toISOString(), approved: false, lockSha256: hash(lock), packages,
  unreviewed: packages.filter(p => !reviewed.has(`${p.name}@${p.version}`)),
  knownIncidentNameMatches: packages.filter(p => banned.has(p.name)),
  archiveVerification: [], osv: [], github: [], errors: [],
};
for (const pkg of packages) {
  const archive = registries.map(dir => path.join(dir, `${pkg.name}-${pkg.version}.crate`)).find(file => fs.existsSync(file));
  report.archiveVerification.push({name: pkg.name, version: pkg.version, present: !!archive, matchesLock: archive ? hash(fs.readFileSync(archive)) === pkg.checksum : false});
}
async function json(url, options = {}) {
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
  return {data: await response.json(), link: response.headers.get('link')};
}
for (let offset = 0; offset < packages.length; offset += 100) {
  const group = packages.slice(offset, offset + 100);
  try {
    const {data} = await json('https://api.osv.dev/v1/querybatch', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({queries: group.map(p => ({package: {ecosystem: 'crates.io', name: p.name}, version: p.version}))})});
    group.forEach((pkg, i) => { if (data.results[i]?.vulns?.length) report.osv.push({...pkg, advisories: data.results[i].vulns}); });
  } catch (error) { report.errors.push({check: 'osv', offset, error: error.message}); }
}
for (let offset = 0; offset < packages.length; offset += 50) {
  for (const type of ['reviewed', 'malware', 'unreviewed']) {
    const url = new URL('https://api.github.com/advisories');
    url.searchParams.set('ecosystem', 'rust'); url.searchParams.set('type', type); url.searchParams.set('per_page', '100');
    url.searchParams.set('affects', packages.slice(offset, offset + 50).map(p => `${p.name}@${p.version}`).join(','));
    try {
      let next = url.href;
      while (next) {
        const target = new URL(next);
        if (target.hostname !== 'api.github.com' || target.pathname !== '/advisories') throw new Error('Unexpected advisory endpoint');
        const {data, link} = await json(next, {headers: {Accept: 'application/vnd.github+json'}});
        for (const advisory of data) if (!report.github.some(a => a.ghsa_id === advisory.ghsa_id)) report.github.push(advisory);
        next = link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
      }
    } catch (error) { report.errors.push({check: 'github', offset, type, error: error.message}); }
  }
}
fs.writeFileSync('.security-review/windows-lock-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({packages: packages.length, unreviewed: report.unreviewed, incidents: report.knownIncidentNameMatches,
  archivesMissingOrChanged: report.archiveVerification.filter(p => !p.matchesLock), osv: report.osv,
  github: report.github.map(a => ({id: a.ghsa_id, summary: a.summary, url: a.html_url, withdrawn: a.withdrawn_at})), errors: report.errors}, null, 2));
