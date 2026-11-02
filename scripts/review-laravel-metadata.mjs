// First-party, read-only public-metadata review. Never installs/imports package code.
// Output is deliberately a local JSON report, not a Composer manifest or lockfile.
import fs from 'node:fs';
const inventory = JSON.parse(fs.readFileSync('.security-review/laravel-lock-inventory.json', 'utf8'));
const candidates = [
  {name: 'laravel/framework', version: 'v12.69.0'},
  {name: 'guzzlehttp/guzzle', version: '7.15.2'},
  {name: 'league/commonmark', version: '2.10.2'},
  {name: 'league/flysystem', version: '3.35.3'},
  {name: 'guzzlehttp/promises', version: '2.5.1'},
  {name: 'guzzlehttp/psr7', version: '2.13.0'},
  {name: 'symfony/http-foundation', version: 'v7.4.21'},
];
const packages = [...inventory.packages, ...candidates];
const report = {timestamp: new Date().toISOString(), packages: [], errors: []};
async function json(url, options = {}) {
  const allowed = new Set(['repo.packagist.org', 'packagist.org', 'api.osv.dev']);
  if (!allowed.has(new URL(url).hostname)) throw new Error('Unapproved metadata origin');
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`${response.status} ${new URL(url).hostname}`);
  return response.json();
}
for (let offset = 0; offset < packages.length; offset += 5) {
  await Promise.all(packages.slice(offset, offset + 5).map(async pkg => {
    try {
      const data = await json(`https://repo.packagist.org/p2/${pkg.name}.json`);
      // Composer v2 metadata may be minified using inherited properties; preserve raw data.
      const versions = data.packages?.[pkg.name] || [];
      const index = versions.findIndex(v => v.version?.replace(/^v/, '') === pkg.version.replace(/^v/, ''));
      if (index < 0) throw new Error(`Version not found: ${pkg.name}@${pkg.version}`);
      const metadata = {};
      for (let i = 0; i <= index; i++) Object.assign(metadata, versions[i]);
      for (const [key, value] of Object.entries(metadata)) if (value === '__unset') delete metadata[key];
      report.packages.push({name: pkg.name, version: pkg.version, metadata, rawVersion: versions[index]});
    } catch (error) { report.errors.push({package: pkg.name, version: pkg.version, error: error.message}); }
  }));
}
report.publishers = [];
for (const candidate of candidates) {
  try {
    const {package: pkg} = await json(`https://packagist.org/packages/${candidate.name}.json`);
    report.publishers.push({name: candidate.name, repository: pkg.repository,
      created: pkg.time, maintainers: pkg.maintainers, downloads: pkg.downloads,
      versions: Object.values(pkg.versions || {}).filter(v => /^v?\d+\.\d+\.\d+$/.test(v.version))
        .slice(0, 12).map(v => ({version: v.version, time: v.time, source: v.source}))});
  } catch (error) { report.errors.push({package: candidate.name, phase: 'publisher', error: error.message}); }
}
try {
  report.osv = await json('https://api.osv.dev/v1/querybatch', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({queries: packages.map(p => ({package: {name: p.name, ecosystem: 'Packagist'}, version: p.version.replace(/^v/, '')}))})
  });
  report.osvPackages = packages.map(({name, version}) => ({name, version}));
} catch (error) { report.errors.push({service: 'OSV', error: error.message}); }
try {
  const url = new URL('https://packagist.org/api/security-advisories/');
  for (const name of new Set(packages.map(p => p.name))) url.searchParams.append('packages[]', name);
  report.packagistAdvisories = await json(url);
} catch (error) { report.errors.push({service: 'Packagist advisories', error: error.message}); }
fs.writeFileSync('.security-review/laravel-public-metadata.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({packages: report.packages.length, errors: report.errors,
  osvFindings: report.osv?.results?.flatMap((r, i) => r.vulns?.length ? [{...report.osvPackages[i], ids: r.vulns.map(v => v.id)}] : [])}));
