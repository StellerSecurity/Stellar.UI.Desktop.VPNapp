// First-party metadata graph planning. No Composer execution, installation or package imports.
import fs from 'node:fs';
const lock = JSON.parse(fs.readFileSync('.security-review/backend-staging/composer.lock', 'utf8'));
const byName = new Map(lock.packages.map(p => [p.name, p]));
const included = new Map();
const missing = new Set();
function visit(name) {
  if (name === 'php' || name.startsWith('ext-') || name.startsWith('lib-') || name.startsWith('composer-')) return;
  if (included.has(name)) return;
  const pkg = byName.get(name);
  if (!pkg) { missing.add(name); return; }
  included.set(name, pkg);
  for (const dependency of Object.keys(pkg.require || {})) visit(dependency);
}
visit('laravel/framework');
if (missing.size) throw new Error(`Unresolved runtime packages: ${[...missing].join(', ')}`);
const packages = [...included.values()].sort((a,b) => a.name.localeCompare(b.name));
const plan = {
  status: 'PENDING_FULL_REVIEW_AND_EXPLICIT_INSTALL_APPROVAL',
  purpose: 'Minimal framework graph for Desktop API v2; no legacy integration/telemetry packages or dev tooling.',
  source: 'Metadata closure of already-reviewed reference lock; NOT a resolved Composer lock or installation manifest.',
  root: {name: 'laravel/framework', version: byName.get('laravel/framework').version},
  packages,
  excluded: lock.packages.filter(p => !included.has(p.name)).map(p => ({name: p.name, version: p.version})),
  limitations: ['Version constraints and platform extensions must be verified by approved Composer resolution.', 'No metadata-only approval authorizes package download/install or Laravel execution.']
};
fs.writeFileSync('.security-review/api-v2-runtime-plan.json', JSON.stringify(plan, null, 2));
console.log(JSON.stringify({packages: packages.length, excluded: plan.excluded, exactVersions: packages.map(p => `${p.name}@${p.version}`)}, null, 2));
