// First-party read-only dependency audit. Never imports/executes dependency code,
// installs scanners, downloads source archives, or reads application credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyLinuxGlib } from './check-linux-glib.mjs';

const report = { timestamp: new Date().toISOString(), lockfiles: [], packages: [], osv: [], github: [], errors: [], sourceCoverage: {}, runtime: null };
// Keep locally patched upstream packages visible to advisory databases. A path
// override must not silently make the original package disappear from the audit.
report.localBackports = [verifyLinuxGlib()];
const hash = data => createHash('sha256').update(data).digest('hex');
function read(file) {
  const data = fs.readFileSync(file);
  report.lockfiles.push({ path: file, sha256: hash(data) });
  return data.toString('utf8');
}
function cargo(file, scope) {
  return read(file).split('[[package]]').slice(1).flatMap(block => {
    if (!block.includes('registry+')) {
      if (file === 'Cargo.lock' && /^name = "glib"$/m.test(block)) {
        return [{ name: 'glib', version: '0.18.5', ecosystem: 'crates.io', scope, sourcePath: 'vendor/glib-0.18.5', localBackport: 'RUSTSEC-2024-0429' }];
      }
      return [];
    }
    return [{ name: block.match(/\nname = "([^"]+)"/)[1], version: block.match(/\nversion = "([^"]+)"/)[1], ecosystem: 'crates.io', scope }];
  });
}
const npm = JSON.parse(read('package-lock.json'));
report.packages.push(...Object.entries(npm.packages).filter(([key]) => key).map(([key, value]) => ({ name: key.split('node_modules/').at(-1), version: value.version, ecosystem: 'npm', scope: 'project', sourcePath: key })));
report.packages.push(...cargo('Cargo.lock', 'project'));
const composer = JSON.parse(read('desktop-api/composer.lock'));
report.packages.push(...[...composer.packages, ...(composer['packages-dev'] || [])].map(p => ({ name: p.name, version: p.version.replace(/^v/, ''), ecosystem: 'Packagist', scope: 'project' })));
if (fs.existsSync('.security-review/notification-dbus-review/Cargo.lock')) report.packages.push(...cargo('.security-review/notification-dbus-review/Cargo.lock', 'notification-candidate'));
const packages = [...new Map(report.packages.map(p => [`${p.ecosystem}:${p.name}@${p.version}`, p])).values()];
const malwareNames = new Set(['proc-macro1', 'proc-macro-en', 'tauri-winrt-notifications', 'tauri-win-rt-notification', 'winx-rs', 'openvpn-plugin-rs', 'rands', 'plain-crypto-js']);
report.knownMalwareNameMatches = packages.filter(p => malwareNames.has(p.name));

const cargoRoot = path.join(os.homedir(), '.cargo/registry/src');
const registries = fs.existsSync(cargoRoot) ? fs.readdirSync(cargoRoot).map(name => path.join(cargoRoot, name)) : [];
const source = [];
const suspicious = /child_process|execSync|spawnSync|Command::new|\bexec\s*\(|\bspawn\s*\(|\beval\s*\(|\bFunction\s*\(|\bcurl\b|\bwget\b|LaunchAgents|LaunchDaemons|launchctl|\.ssh\b|\.gnupg\b|\.aws\b|\.azure\b|Login Data|browser.profile|password.store|BEGIN.*PRIVATE KEY|crontab|systemctl|base64.*decode/i;
const critical = /LaunchAgents|LaunchDaemons|launchctl|[/'"]\.ssh[/'"]|[/'"]\.gnupg[/'"]|[/'"]\.aws[/'"]|[/'"]\.azure[/'"]|Login Data|browser.profile|password.store|crontab/i;
for (const pkg of report.packages.filter(p => p.scope === 'project')) {
  let directory;
  if (pkg.ecosystem === 'npm') directory = pkg.sourcePath;
  if (pkg.ecosystem === 'Packagist') directory = path.join('desktop-api/vendor', pkg.name);
  if (pkg.ecosystem === 'crates.io') directory = pkg.sourcePath ?? registries.map(root => path.join(root, `${pkg.name}-${pkg.version}`)).find(dir => fs.existsSync(dir));
  const entry = { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem, available: !!directory && fs.existsSync(directory), files: 0, lifecycle: {}, hits: [], skipped: [] };
  if (entry.available) {
    const manifestName = pkg.ecosystem === 'npm' ? 'package.json' : pkg.ecosystem === 'Packagist' ? 'composer.json' : 'Cargo.toml';
    const manifestPath = path.join(directory, manifestName);
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      entry.manifestSha256 = hash(raw);
      if (pkg.ecosystem === 'crates.io') entry.lifecycle = { build: raw.match(/^build\s*=\s*"([^"]+)"/m)?.[1] || (fs.existsSync(path.join(directory, 'build.rs')) ? 'build.rs' : null) };
      else {
        const manifest = JSON.parse(raw); entry.lifecycle = manifest.scripts || {};
        entry.installedVersion = manifest.version || null;
        if (entry.installedVersion && entry.installedVersion.replace(/^v/, '') !== pkg.version) entry.versionMismatch = true;
      }
    }
    function scan(dir) {
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'target', 'test', 'tests', 'examples', 'benches', 'docs'].includes(file.name)) continue;
        const full = path.join(dir, file.name);
        if (file.isSymbolicLink()) { entry.skipped.push({ path: path.relative(directory, full), reason: 'symlink' }); continue; }
        if (file.isDirectory()) { scan(full); continue; }
        if (!/\.(rs|js|mjs|cjs|ts|php|sh|py|c|h|m|mm|ps1)$/i.test(file.name)) continue;
        if (fs.statSync(full).size > 4_000_000) { entry.skipped.push({ path: path.relative(directory, full), reason: 'size' }); continue; }
        entry.files++;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (suspicious.test(line)) entry.hits.push({ file: path.relative(directory, full), line: i + 1, priority: critical.test(line) ? 'manual-review' : 'capability', text: line.trim().slice(0, 350) });
        });
      }
    }
    scan(directory);
  }
  source.push(entry);
}
report.sourceCoverage = { packages: source.length, available: source.filter(p => p.available).length, missing: source.filter(p => !p.available).map(({ name, version, ecosystem }) => ({ name, version, ecosystem })), reviews: source };

const runtimeManifest = 'src-tauri/resources/openvpn-runtime/runtime-manifest.json';
if (fs.existsSync(runtimeManifest)) {
  const runtime = JSON.parse(read(runtimeManifest));
  report.runtime = { platform: runtime.platform, packages: runtime.packages, files: runtime.files.map(file => {
    if (path.basename(file.file) !== file.file) throw new Error('Unexpected runtime manifest path');
    const data = fs.readFileSync(path.join(path.dirname(runtimeManifest), file.file));
    const actual = hash(data); return { file: file.file, expected: file.sha256, actual, matches: actual === file.sha256 };
  }) };
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).hostname}`);
  return { data: await response.json(), link: response.headers.get('link') };
}
for (let i = 0; i < packages.length; i += 100) {
  const group = packages.slice(i, i + 100);
  try {
    const { data } = await json('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: group.map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }) });
    for (let j = 0; j < group.length; j++) if (data.results[j]?.vulns?.length) report.osv.push({ ...group[j], advisories: data.results[j].vulns });
  } catch (error) { report.errors.push({ check: 'osv', packages: group.map(p => `${p.name}@${p.version}`), error: error.message }); }
}
report.osvDetails = [];
for (const id of [...new Set(report.osv.flatMap(p => p.advisories.map(a => a.id)))]) {
  try { report.osvDetails.push((await json(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)).data); }
  catch (error) { report.errors.push({ check: 'osv-detail', id, error: error.message }); }
}
const githubEcosystems = { 'crates.io': 'rust', npm: 'npm', Packagist: 'composer' };
for (const [ecosystem, githubName] of Object.entries(githubEcosystems)) {
  const entries = packages.filter(p => p.ecosystem === ecosystem);
  for (let i = 0; i < entries.length; i += 50) {
    for (const type of ['reviewed', 'malware', 'unreviewed']) {
      const url = new URL('https://api.github.com/advisories');
      url.searchParams.set('ecosystem', githubName); url.searchParams.set('type', type); url.searchParams.set('per_page', '100');
      url.searchParams.set('affects', entries.slice(i, i + 50).map(p => `${p.name}@${p.version}`).join(','));
      try {
        let next = url.href;
        while (next) {
          const target = new URL(next);
          if (target.hostname !== 'api.github.com' || target.pathname !== '/advisories') throw new Error('Unexpected advisory URL');
          const { data, link } = await json(next, { headers: { Accept: 'application/vnd.github+json' } });
          for (const a of data) if (!report.github.some(old => old.ghsa_id === a.ghsa_id)) report.github.push(a);
          next = link?.match(/<([^>]+)>; rel="next"/)?.[1] || null;
        }
      } catch (error) { report.errors.push({ check: 'github', ecosystem, type, offset: i, error: error.message }); }
    }
  }
}
fs.mkdirSync('.security-review', { recursive: true });
fs.writeFileSync('.security-review/full-dependency-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ timestamp: report.timestamp, uniquePackages: packages.length, projectPackages: report.packages.filter(p => p.scope === 'project').length,
  knownMalwareNameMatches: report.knownMalwareNameMatches, sourceAvailable: report.sourceCoverage.available, sourceMissing: report.sourceCoverage.missing.length,
  manualReviewPackages: source.filter(p => p.hits.some(h => h.priority === 'manual-review')).map(p => ({ name: p.name, version: p.version, hits: p.hits.filter(h => h.priority === 'manual-review').length })),
  osv: report.osv.map(p => ({ name: p.name, version: p.version, ecosystem: p.ecosystem, advisories: p.advisories })),
  github: report.github.map(a => ({ id: a.ghsa_id, summary: a.summary, url: a.html_url, withdrawn: a.withdrawn_at })),
  runtimeHashesMatch: report.runtime?.files.every(p => p.matches), errors: report.errors }, null, 2));
