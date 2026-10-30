// First-party source-only overlay; no dependencies, credentials, caches or migrations.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const before = {
  'app/Application/AuthService.php':'04811e373ef22505b5d9e74064b8b9f0a40e98bd655cd2f636ae1a51e2fd98f4',
  'app/Http/Controllers/AuthController.php':'8d51c3665fb074a9d322fb22128a723205ab01d1cbd2a78a20d8c52323dd5f41',
  'app/Infrastructure/ScopedUserApiClient.php':'d989a993522cbda02633f8db20023035d73bbf27ead187986aaf44c65aa87780',
  'app/Infrastructure/UserApiIdentityGateway.php':'d4778189a0948a9a8d1396e5c3432db351f6c02f3964fbad3be47c9ad68af167',
  'app/Providers/DesktopApiServiceProvider.php':'c6eafce5fc90ae8daefdf400a227f065a8c8fec3e9f60e89ded63654d1914fa9',
  'routes/api.php':'ee09350e32889a3ee542e05804a0653b9fd413fd7e26f8801df75347e2972685',
  'app/Domain/Session.php':'be70f48534c661d88e8e35026a4b15b2e2ab7bfac2ef2ca5ee6909569ef69060',
  'app/Infrastructure/SubscriptionApiGateway.php':'ed57f4fe71036cffbf9052a730cb4ae063fb5a8877fa456c5954a642f64b06eb',
  'app/Application/AccountService.php':'22f63490007bb5a969b37c80a067ad8c4499c3e2e5a09f599137a57333b1000b',
  'app/Application/VpnLoginService.php':'72c1f5b4348f4887fa2184b36e6c6cb4a266cd124ec59de39d6962e7649eebb0',
  'app/Http/Controllers/ActivationController.php':'d5cdef0b99cbe3e1d6caabad4860a6a6eb333a623a2f6b9f7d2df3e7a1688312',
  'app/Http/Controllers/VpnConfigurationController.php':'8d3fa53132d9eceda83d391c91603b4a702106b3a3c2d7a9e6f9f54e96516263',
  'app/Application/Ports/AnonymousIdentityGateway.php':null,
  'app/Application/Ports/SelectedSubscriptionGateway.php':null,
  'app/Application/SessionSubscription.php':null,
  'app/Infrastructure/AnonymousAccountGateway.php':null,
  'app/Infrastructure/AndroidVpnSessionGateway.php':null,
};
const directory = fs.mkdtempSync('/tmp/stellar-android-login-');
const release = 'stellar-android-login-20261030-v2';
fs.mkdirSync(`${directory}/${release}`);
const files = Object.entries(before).map(([path, previous]) => {
  if (previous && !/^[a-f0-9]{64}$/.test(previous)) throw Error(`Invalid baseline hash: ${path}`);
  const content = fs.readFileSync(`desktop-api/${path}`);
  return {path,before:previous,after:createHash('sha256').update(content).digest('hex'),content:content.toString('base64')};
});
const manifest = JSON.stringify({files});
fs.writeFileSync(`${directory}/${release}/payload.json`, manifest);
fs.copyFileSync('scripts/deploy-android-login.php',`${directory}/${release}/deploy.php`);
fs.copyFileSync('api-upgrades/deploy-console.php',`${directory}/${release}/console.php`);
const archive = `${directory}.zip`;
if (spawnSync('/usr/bin/zip',['-q','-r',archive,release],{cwd:directory}).status !== 0) throw Error('Packaging failed');
console.log(JSON.stringify({archive,files:files.length,manifestSha256:createHash('sha256').update(manifest).digest('hex'),release}));
