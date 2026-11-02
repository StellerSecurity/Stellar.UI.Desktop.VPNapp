// First-party review helper. Reads downloaded manifests/source as data; never imports package code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const cargoRoot = path.join(os.homedir(), '.cargo', 'registry', 'src');
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const crates = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)]
  .filter(match => match[3]).map(match => ({ name: match[1], version: match[2], ecosystem: 'crates.io' }));
const npmLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const npm = Object.entries(npmLock.packages).filter(([name]) => name).map(([name, data]) => ({ name: name.split('node_modules/').at(-1), version: data.version, ecosystem: 'npm' }));
const banned = new Set(['proc-macro1', 'proc-macro-en', 'aovine', 'arone', 'aronenao', 'tinymember', 'tauri-win-rt-notification', 'plain-crypto-js']);
const patterns = /child_process|execSync|spawnSync|Command::new|\.spawn\(|\.exec\(|\beval\(|\bFunction\(|curl|wget|https?:\/\/|LaunchAgents|LaunchDaemons|launchctl|\.ssh|\.gnupg|\.aws|\.azure|Cookies|Login Data|password.store|PRIVATE.KEY|base64::decode/;
const severe = /LaunchAgents|LaunchDaemons|launchctl|\.ssh[/'"]|\.gnupg[/'"]|\.aws[/'"]|\.azure[/'"]|Login Data|BEGIN.*PRIVATE KEY/;
const sourceReviews = [];
const registry = fs.readdirSync(cargoRoot).map(name => path.join(cargoRoot, name));
for (const crate of crates) {
  if (banned.has(crate.name) || (crate.name === 'arrayref' && crate.version === '0.3.10') || (crate.name === 'internment' && crate.version === '0.8.7') || (crate.name === 'append-only-vec' && crate.version === '0.1.9')) throw new Error(`Blocked known malware: ${crate.name}@${crate.version}`);
  const directory = registry.map(base => path.join(base, `${crate.name}-${crate.version}`)).find(dir => fs.existsSync(dir));
  if (!directory) throw new Error(`Missing review source: ${crate.name}@${crate.version}`);
  const manifest = fs.readFileSync(path.join(directory, 'Cargo.toml'), 'utf8');
  const build = manifest.match(/^build = "([^"]+)"/m)?.[1] || (fs.existsSync(path.join(directory, 'build.rs')) ? 'build.rs' : null);
  const hits = [];
  const severeHits = [];
  function scan(dir) {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'target', 'tests', 'test', 'examples', 'benches'].includes(file.name)) continue;
      const full = path.join(dir, file.name);
      if (file.isDirectory()) { scan(full); continue; }
      if (!/\.(rs|js|ts|sh|py)$/.test(file.name) || fs.statSync(full).size > 4_000_000) continue;
      const text = fs.readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (patterns.test(line)) hits.push({ file: path.relative(directory, full), line: i + 1, text: line.trim().slice(0, 500) });
        if (severe.test(line)) severeHits.push({ file: path.relative(directory, full), line: i + 1, text: line.trim() });
      });
    }
  }
  scan(directory);
  sourceReviews.push({ ...crate, directory, repository: manifest.match(/^repository = "([^"]+)"/m)?.[1], build,
    buildSource: build ? fs.readFileSync(path.join(directory, build), 'utf8') : null, hits, severeHits });
}
const npmReviews = npm.filter(pkg => fs.existsSync(path.join('node_modules', pkg.name, 'package.json'))).map(pkg => {
  if (banned.has(pkg.name)) throw new Error(`Blocked package ${pkg.name}`);
  const manifest = JSON.parse(fs.readFileSync(path.join('node_modules', pkg.name, 'package.json'), 'utf8'));
  return { ...pkg, scripts: manifest.scripts || {}, repository: manifest.repository };
});
fs.mkdirSync('.security-review', { recursive: true });
const report = { timestamp: new Date().toISOString(), crates: sourceReviews, npm: npmReviews };
fs.writeFileSync('.security-review/source-review.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ crates: crates.length, npm: npm.length, buildScripts: sourceReviews.filter(pkg => pkg.build).map(pkg => `${pkg.name}@${pkg.version}`), severe: sourceReviews.filter(pkg => pkg.severeHits.length).map(pkg => ({ name: pkg.name, hits: pkg.severeHits })) }, null, 2));
if (process.argv.includes('--osv')) {
  const packages = [...crates, ...npm];
  const response = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: packages.map(pkg => ({ package: { name: pkg.name, ecosystem: pkg.ecosystem }, version: pkg.version })) }) });
  if (!response.ok) throw new Error(`OSV HTTP ${response.status}`);
  const data = await response.json();
  const findings = data.results.flatMap((result, index) => result.vulns?.length ? [{ ...packages[index], advisories: result.vulns }] : []);
  fs.writeFileSync('.security-review/osv-review.json', JSON.stringify({ timestamp: new Date().toISOString(), packages: packages.length, findings }, null, 2));
  console.log(JSON.stringify({ osv: findings }, null, 2));
}
