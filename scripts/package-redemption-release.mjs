// First-party source-only release artifact. No dependencies, environment or credentials included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-redemption-'));
const full = process.argv.includes('--release');
const rootName = full ? 'stellar-redemption-release-20261029-v3' : 'stellar-redemption-release-20261029-v1';
const root = path.join(stage, rootName);
const files = [
  ['api-upgrades/deploy-preflight.php', 'preflight.php'],
  ['api-upgrades/subscriptions/config/vpn-redemption.php', 'subscriptions/config/vpn-redemption.php'],
  ['desktop-api/config/desktop-api.php', 'desktop/config/desktop-api.php'],
];
const hash = data => createHash('sha256').update(data).digest('hex');
const release = {};
if (full) {
  files.push(['api-upgrades/deploy-release.php','deploy.php']);
  files.push(['api-upgrades/deploy-console.php','console.php']);
  const originals = JSON.parse(fs.readFileSync('.security-review/redemption-upstream-originals.json','utf8'));
  const paths = {
    'activation-license': ['app/Http/Controllers/V1/VpnRedemptionController.php','app/Http/Middleware/RedemptionSafeTrackRequest.php','database/migrations/2026_10_29_120000_create_vpn_license_redemptions.php','app/Http/Controllers/V1/ActivationLicenseController.php','app/Http/Kernel.php','routes/api.php'],
    subscriptions: ['app/Http/Controllers/v1/VpnLicenseCreditController.php','config/vpn-redemption.php','database/migrations/2026_10_29_120000_create_vpn_license_credits.php','routes/api.php'],
    desktop: ['app/Application/ActivationRejected.php','app/Infrastructure/ActivationApiGateway.php','app/Http/Controllers/ActivationController.php','config/desktop-api.php','app/Providers/DesktopApiServiceProvider.php','routes/api.php'],
  };
  const desktopBefore = (file,content) => {
    let before=content;
    if(file==='routes/api.php') before=before.replace(/^Route::post\('\/account\/activation'.*\n/m,'');
    if(file==='config/desktop-api.php') before=before.replace(/^    \/\/ Enable only after BOTH.*\n(?:    'activation_.*\n){3}/m,'');
    if(file==='app/Providers/DesktopApiServiceProvider.php') {
      before=before.replace(/^        \$this->app->singleton\(\\Stellar\\DesktopApi\\Infrastructure\\ActivationApiGateway::class[^\n]*\n[^\n]*\n[^\n]*\n/m,'');
      before=before.replace(/^        RateLimiter::for\('activation'.*\n/m,'');
    }
    if(before===content) throw new Error('Missing exact activation change: '+file);
    return before;
  };
  for (const [role,entries] of Object.entries(paths)) {
    release[role]={files:[],routes: role==='activation-license'?['api/v1/vpn-redemptions/claim','api/v1/vpn-redemptions/receipt']:role==='subscriptions'?['api/v1/subscriptioncontroller/license-credit']:['api/v2/account/activation']};
    if(role!=='desktop') {
      release[role].table=role==='activation-license'?'vpn_license_redemptions':'vpn_license_credits';
      release[role].baseTable=role==='activation-license'?'activationlicenses':'subscriptions';
      release[role].migration=entries.find(x=>x.startsWith('database/migrations/'));
    }
    for(const file of entries) {
      const source=role==='desktop'?'desktop-api/'+file:'api-upgrades/'+role+'/'+file;
      const content=fs.readFileSync(source,'utf8');
      let before=originals[role+'/'+file]??null;
      if(role==='desktop'&&['routes/api.php','config/desktop-api.php','app/Providers/DesktopApiServiceProvider.php'].includes(file)) before=desktopBefore(file,content);
      release[role].files.push({path:file,before:before===null?null:hash(before),after:hash(content)});
      if(!files.some(([,target])=>target===role+'/'+file)) files.push([source,role+'/'+file]);
    }
  }
}
const manifest = [];
for (const [source, target] of files) {
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('Non-regular source rejected');
  const data = fs.readFileSync(source), output = path.join(root, target);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, data, {flag:'wx'});
  manifest.push({ path: target, sha256: createHash('sha256').update(data).digest('hex') });
}
if(full) fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(release,null,2),{flag:'wx'});
const zip = path.join(stage, full?'stellar-redemption-release.zip':'stellar-redemption-preflight.zip');
const result = spawnSync('/usr/bin/zip', ['-q', '-r', zip, rootName], { cwd: stage, stdio: 'inherit' });
if (result.status !== 0) throw new Error('ZIP packaging failed');
console.log(JSON.stringify({ rootName, zip, sha256: createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), files: manifest, release }, null, 2));
