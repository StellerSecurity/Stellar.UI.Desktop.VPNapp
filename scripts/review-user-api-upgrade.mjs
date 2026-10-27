// First-party read-only review. Fetch JSON/manifests/source as inert text only.
// No archive downloads, dependency imports, package-manager calls or PHP execution.
import fs from 'node:fs';
const requested = [
 ['laravel/framework', 'v12.69.0'], ['guzzlehttp/guzzle', '7.15.2'],
 ['laravel/sanctum', 'v4.3.3'], ['laravel/tinker', 'v2.11.1'],
 ['fakerphp/faker', 'v1.24.1'], ['laravel/pint', 'v1.32.1'],
 ['laravel/sail', 'v1.69.0'], ['mockery/mockery', '1.6.15'],
 ['nunomaduro/collision', 'v8.9.5'], ['phpunit/phpunit', '11.5.57'],
 ['spatie/laravel-ignition', '2.12.1'],
];
const samples = {
 'laravel/sanctum': ['src/HasApiTokens.php', 'src/PersonalAccessToken.php', 'src/Guard.php', 'src/SanctumServiceProvider.php'],
 'laravel/tinker': ['src/Console/TinkerCommand.php', 'src/TinkerServiceProvider.php'],
 'fakerphp/faker': ['src/Faker/Generator.php', 'src/Faker/Provider/File.php'],
 'laravel/pint': ['app/Commands/DefaultCommand.php'], 'laravel/sail': ['bin/sail', 'src/Console/InstallCommand.php'],
 'mockery/mockery': ['library/Mockery.php', 'library/Mockery/Loader/EvalLoader.php'],
 'nunomaduro/collision': ['src/Provider.php', 'src/Adapters/Laravel/CollisionServiceProvider.php'],
 'phpunit/phpunit': ['phpunit', 'src/TextUI/Application.php'],
 'spatie/laravel-ignition': ['src/IgnitionServiceProvider.php'],
 'laravel/framework': ['src/Illuminate/Foundation/ComposerScripts.php'],
 'guzzlehttp/guzzle': ['src/Client.php'],
};
const report = {date: new Date().toISOString(), scope: 'Metadata-resolution candidates only; NOT installation approval or a resolved lock', packages: [], errors: []};
async function read(url, options = {}) {
 if (!['packagist.org', 'raw.githubusercontent.com', 'api.osv.dev', 'api.github.com'].includes(new URL(url).hostname)) throw Error('Unexpected origin');
 const r = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(25000)});
 if (!r.ok) throw Error(`${r.status}: ${url}`);
 return r.text();
}
const capability = /(?:\b(?:exec|shell_exec|system|passthru|proc_open|popen|eval|getenv|unserialize)\s*\(|child_process|spawn|LaunchAgents|LaunchDaemons|launchctl|\.ssh|\.gnupg|\.aws|\.azure|Login Data|PRIVATE.KEY|https?:\/\/|base64_decode|file_get_contents|file_put_contents)/i;
for (const [name, version] of requested) {
 try {
  const registry = JSON.parse(await read(`https://packagist.org/packages/${name}.json`)).package;
  const p = Object.values(registry.versions).find(v => v.version.replace(/^v/, '') === version.replace(/^v/, ''));
  if (!p || !/^https:\/\/github.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(p.source?.url) || !/^[a-f0-9]{40}$/.test(p.source.reference)) throw Error('Missing exact official source');
  const repo = p.source.url.replace('https://github.com/', '').replace(/\.git$/, '');
  const base = `https://raw.githubusercontent.com/${repo}/${p.source.reference}/`;
  const manifest = JSON.parse(await read(base + 'composer.json'));
  const row = {name, version, source: p.source, dist: p.dist, require: p.require,
   registry: {repository: registry.repository, created: registry.time, maintainers: registry.maintainers, downloads: registry.downloads,
    release: p.time, history: Object.values(registry.versions).filter(v => /^v?\d+\.\d+\.\d+$/.test(v.version)).slice(0,8).map(v => ({version: v.version, time: v.time}))},
   manifest, scripts: manifest.scripts || {}, files: []};
  for (const path of [...new Set([...(manifest.autoload?.files || []), ...(samples[name] || [])])]) {
   if (path.startsWith('/') || path.includes('..')) throw Error('Unsafe source path');
   const source = await read(base + path);
   row.files.push({path, source, hits: source.split('\n').flatMap((line, index) => capability.test(line) ? [{line: index+1, text:line.trim().slice(0,350)}] : [])});
  }
  report.packages.push(row);
  console.log(`Read ${name}@${version}`);
 } catch (error) { report.errors.push({name, version, error: error.message}); }
 fs.writeFileSync('.security-review/user-api-upgrade-candidates.json', JSON.stringify(report, null, 2));
}
report.osv = JSON.parse(await read('https://api.osv.dev/v1/querybatch', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({queries:requested.map(([name,version])=>({package:{name,ecosystem:'Packagist'},version:version.replace(/^v/,'')}))})}));
report.osvOrder = requested;
report.github = {};
for (const type of ['reviewed', 'malware', 'unreviewed']) {
 const url = new URL('https://api.github.com/advisories');
 url.searchParams.set('ecosystem', 'composer');
 url.searchParams.set('type', type);
 url.searchParams.set('per_page', '100');
 url.searchParams.set('affects', requested.map(([name,version])=>`${name}@${version.replace(/^v/,'')}`).join(','));
 report.github[type] = JSON.parse(await read(url.href, {headers:{accept:'application/vnd.github+json'}}));
 if (report.github[type].length >= 100) throw Error('Advisory results require pagination; do not treat as complete');
}
fs.writeFileSync('.security-review/user-api-upgrade-candidates.json', JSON.stringify(report,null,2));
console.log(JSON.stringify({errors:report.errors, osv:report.osv.results.flatMap((r,i)=>r.vulns?.length?[{package:requested[i],ids:r.vulns.map(v=>v.id)}]:[]), github:Object.fromEntries(Object.entries(report.github).map(([k,v])=>[k,v.map(a=>a.ghsa_id)])), scripts:report.packages.filter(p=>Object.keys(p.scripts).length).map(p=>({name:p.name,scripts:p.scripts}))}));
