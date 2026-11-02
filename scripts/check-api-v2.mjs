// First-party source/contract checks only; does not boot Laravel or access network.
import fs from 'node:fs';
import path from 'node:path';
const failures = [];
const root = 'desktop-api';
// Reviewed source-only integration; this is NOT permission to activate it in fixture staging.
const preparedIdentityFiles = new Set([
  `${root}/app/Infrastructure/UserApiIdentityGateway.php`,
  `${root}/app/Infrastructure/ScopedUserApiClient.php`,
  `${root}/app/Infrastructure/SubscriptionApiGateway.php`,
  `${root}/app/Infrastructure/AnonymousAccountGateway.php`,
  `${root}/app/Infrastructure/ActivationApiGateway.php`,
  `${root}/tests/activation-http.php`,
  `${root}/app/Infrastructure/DeviceApiGateway.php`,
  `${root}/app/Infrastructure/VpnCredentialApiGateway.php`,
  `${root}/app/Infrastructure/VpnServerApiCatalog.php`,
  `${root}/tests/identity.php`,
  `${root}/tests/http.php`,
  `${root}/tests/vpn-login.php`,
]);
const spec = JSON.parse(fs.readFileSync(`${root}/contracts/openapi.json`, 'utf8'));
const operationIds = new Set();
if (spec.servers.length !== 1 || spec.servers[0].url !== '/api/v2') failures.push('Unexpected API root');
for (const item of Object.values(spec.paths)) for (const operation of Object.values(item)) {
  if (!operation.operationId || operationIds.has(operation.operationId)) failures.push('Missing/duplicate operation ID');
  operationIds.add(operation.operationId);
}
function refs(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/')) failures.push(`External reference: ${value.$ref}`);
    else if (!value.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec)) failures.push(`Broken reference: ${value.$ref}`);
  }
  for (const child of Object.values(value)) refs(child);
}
refs(spec);
function walk(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) { if (!['vendor', 'storage'].includes(item.name)) walk(full); continue; }
    if (!full.endsWith('.php')) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/\/app\/(Domain|Application)\//.test(full)) {
      if (/use\s+(Illuminate|Symfony|GuzzleHttp|Stellar\\DesktopApi\\(Infrastructure|Http|Providers))\\/.test(text)) failures.push(`${full}: outer-layer dependency`);
      if (/\b(file_get_contents|file_put_contents|curl_exec|shell_exec|proc_open|fopen|getenv)\s*\(/.test(text)) failures.push(`${full}: IO in inner layer`);
    }
    if (/https?:\/\/[^\s'";]*(prod|azurewebsites\.net)/i.test(text) && !preparedIdentityFiles.has(full)) failures.push(`${full}: production URL default`);
  }
}
walk(root);
const bindings = fs.readFileSync(`${root}/app/Providers/DesktopApiServiceProvider.php`, 'utf8');
if (!bindings.includes('singleton(IdentityGateway::class, UnavailableIdentityGateway::class)')
  || !bindings.includes("if ($identity === 'user-api')") || !bindings.includes('StagingPolicy::assertFixtureMode(')) {
  failures.push('Identity must default to disabled and require explicit staging opt-in');
}
const identityTest = fs.readFileSync(`${root}/tests/identity.php`, 'utf8');
if (!identityTest.includes('preventStrayRequests()') || !identityTest.includes('APP_ENV')) failures.push('Identity tests must fail closed against live HTTP');
for (const route of ['/auth/login', '/auth/register', '/auth/session', '/auth/logout']) {
  if (!spec.paths[route]?.post.responses['503']) failures.push('Identity contract must document disabled integration');
}
if (spec.components.schemas.HealthResponse.properties.data.properties.ready.enum[0] !== false) failures.push('Foundation must not claim readiness');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`API v2 source boundaries and ${operationIds.size} contract operations passed. Run test:api:v2:http separately for Laravel HTTP coverage.`);
