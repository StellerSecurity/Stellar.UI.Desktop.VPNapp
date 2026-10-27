// First-party review: reads public registry/manifests/source as text data only.
// Never writes PHP source, imports package code, fetches archives or installs packages.
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-plan.json', 'utf8'));
const requested = process.argv.slice(2);
const work = requested.length ? plan.packages.filter(p => requested.includes(p.name)) : plan.packages;
const report = {timestamp: new Date().toISOString(), scope: 'Focused manifest/autoload/representative-source review, not full source certification', packages: [], errors: []};
const sample = {
 'brick/math': ['src/BigInteger.php'], 'carbonphp/carbon-doctrine-types': ['src/Carbon/Doctrine/DateTimeType.php'],
 'dflydev/dot-access-data': ['src/Data.php'], 'doctrine/inflector': ['src/Inflector.php'], 'doctrine/lexer': ['src/AbstractLexer.php'],
 'dragonmantank/cron-expression': ['src/Cron/CronExpression.php'], 'egulias/email-validator': ['src/EmailValidator.php'],
 'fruitcake/php-cors': ['src/CorsService.php'], 'graham-campbell/result-type': ['src/Success.php'],
 'guzzlehttp/guzzle': ['src/Handler/CurlFactory.php', 'src/Handler/ProxyEnvironment.php'], 'guzzlehttp/promises': ['src/Promise.php'],
 'guzzlehttp/psr7': ['src/Uri.php'], 'guzzlehttp/uri-template': ['src/UriTemplate.php'],
 'laravel/framework': ['src/Illuminate/Foundation/ComposerScripts.php', 'src/Illuminate/Concurrency/ProcessDriver.php'],
 'laravel/serializable-closure': ['src/SerializableClosure.php', 'src/Serializers/Native.php'],
 'league/commonmark': ['src/Extension/Attributes/Util/AttributesHelper.php'], 'league/config': ['src/Configuration.php'],
 'league/flysystem': ['src/WhitespacePathNormalizer.php'], 'league/flysystem-local': ['LocalFilesystemAdapter.php'],
 'league/mime-type-detection': ['src/FinfoMimeTypeDetector.php'], 'league/uri': ['Uri.php'], 'league/uri-interfaces': ['Contracts/UriInterface.php'],
 'monolog/monolog': ['src/Monolog/Logger.php', 'src/Monolog/Handler/SocketHandler.php'], 'nesbot/carbon': ['src/Carbon/Carbon.php'],
 'nette/schema': ['src/Schema/Processor.php'], 'nette/utils': ['src/Utils/Json.php'], 'phpoption/phpoption': ['src/PhpOption/Option.php'],
 'psr/clock': ['src/ClockInterface.php'], 'psr/container': ['src/ContainerInterface.php'], 'psr/event-dispatcher': ['src/EventDispatcherInterface.php'],
 'psr/http-client': ['src/ClientInterface.php'], 'psr/http-factory': ['src/RequestFactoryInterface.php'], 'psr/http-message': ['src/MessageInterface.php'],
 'psr/log': ['src/LoggerInterface.php'], 'psr/simple-cache': ['src/CacheInterface.php'], 'ramsey/collection': ['src/Collection.php'],
 'symfony/console': ['Application.php'], 'symfony/css-selector': ['CssSelectorConverter.php'], 'symfony/error-handler': ['ErrorHandler.php'],
 'symfony/event-dispatcher': ['EventDispatcher.php'], 'symfony/event-dispatcher-contracts': ['EventDispatcherInterface.php'],
 'symfony/finder': ['Finder.php'], 'symfony/http-foundation': ['HeaderUtils.php'], 'symfony/http-kernel': ['HttpKernel.php'],
 'symfony/mailer': ['Mailer.php'], 'symfony/mime': ['Email.php'], 'symfony/process': ['Process.php'], 'symfony/routing': ['Route.php'],
 'symfony/service-contracts': ['ResetInterface.php'], 'symfony/translation-contracts': ['TranslatorInterface.php'], 'symfony/uid': ['Uuid.php'],
 'tijsverkoyen/css-to-inline-styles': ['src/CssToInlineStyles.php'], 'vlucas/phpdotenv': ['src/Dotenv.php'], 'voku/portable-ascii': ['src/voku/helper/ASCII.php']
};
const pattern = /\b(?:exec|execSync|spawn|spawnSync|shell_exec|system|passthru|proc_open|popen|eval|base64_decode|file_get_contents|file_put_contents|fopen|curl_exec|getenv|unserialize)\s*\(|child_process|Function\s*\(|LaunchAgents|LaunchDaemons|launchctl|\.ssh|\.gnupg|\.aws|\.azure|browser.profile|Login Data|PRIVATE.KEY|https?:\/\//i;
async function read(url) {
 const host = new URL(url).hostname;
 if (!['packagist.org', 'raw.githubusercontent.com', 'api.osv.dev'].includes(host)) throw new Error('Unexpected review origin');
 const res = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(20000)});
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return res.text();
}
for (let offset = 0; offset < work.length; offset += 5) {
 await Promise.all(work.slice(offset, offset+5).map(async pkg => {
  const row = {name: pkg.name, version: pkg.version, source: pkg.source, files: []};
  try {
   const registry = JSON.parse(await read(`https://packagist.org/packages/${pkg.name}.json`)).package;
   const version = Object.values(registry.versions).find(p => p.version.replace(/^v/, '') === pkg.version.replace(/^v/, ''));
   row.registry = {created: registry.time, repository: registry.repository, maintainers: registry.maintainers.map(m => m.name), downloads: registry.downloads,
    releaseTime: version?.time, sourceMatches: version?.source?.reference === pkg.source.reference,
    history: Object.values(registry.versions).filter(v=>/^v?\d+\.\d+\.\d+$/.test(v.version)).slice(0,5).map(v=>({version:v.version,time:v.time}))};
   if (!row.registry.sourceMatches) throw new Error('Registry source does not match pinned commit');
   const repo = pkg.source.url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
   if (!repo || !/^[a-f0-9]{40}$/.test(pkg.source.reference)) throw new Error('Unrecognized pinned GitHub source');
   const base = `https://raw.githubusercontent.com/${repo}/${pkg.source.reference}/`;
   row.manifest = JSON.parse(await read(base+'composer.json'));
   row.lifecycleScripts = Object.fromEntries(Object.entries(row.manifest.scripts || {}).filter(([name])=> /^(pre|post)-(install|update|autoload-dump|package-install|package-update|package-uninstall)/.test(name) || /^(install|prepare|preinstall|postinstall)$/.test(name)));
   const files = [...new Set([...(row.manifest.autoload?.files || []), ...(sample[pkg.name] || [])])];
   for (const file of files) {
    if (file.includes('..') || file.startsWith('/')) throw new Error('Suspicious source path');
    try {
     const text = await read(base+file);
     row.files.push({path: file, bytes: text.length, source: text, hits: text.split('\n').flatMap((line, i)=>pattern.test(line)?[{line: i+1,text:line.trim().slice(0,500)}]:[])});
    } catch (error) { row.files.push({path: file, error: error.message}); }
   }
   if (!row.files.some(f=>f.source)) report.errors.push({name:pkg.name,phase:'source',error:'No source sample available'});
  } catch (error) { row.error = error.message; report.errors.push({name:pkg.name,error:error.message}); }
  report.packages.push(row);
 }));
 console.log(`Metadata/source reviewed ${Math.min(offset+5,work.length)}/${work.length}`);
 fs.writeFileSync(requested.length ? '.security-review/api-v2-runtime-source-retry.json' : '.security-review/api-v2-runtime-source.json', JSON.stringify(report,null,2));
}
const osvResponse = await fetch('https://api.osv.dev/v1/querybatch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({queries:plan.packages.map(p=>({package:{name:p.name,ecosystem:'Packagist'},version:p.version.replace(/^v/,'')}))}),signal:AbortSignal.timeout(20000)});
if (!osvResponse.ok) throw new Error(`OSV ${osvResponse.status}`);
report.osv = await osvResponse.json();
report.osvPackages = plan.packages.map(({name,version})=>({name,version}));
if (requested.length) {
 const previous = JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-source.json','utf8'));
 report.packages = [...previous.packages.filter(p=>!requested.includes(p.name)), ...report.packages];
 report.errors = [...previous.errors.filter(p=>!requested.includes(p.name)), ...report.errors];
}
fs.writeFileSync('.security-review/api-v2-runtime-source.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({packages:report.packages.length,errors:report.errors,hooks:report.packages.filter(p=>Object.keys(p.lifecycleScripts||{}).length).map(p=>({name:p.name,scripts:p.lifecycleScripts})),osvMatches:report.osv.results.flatMap((r,i)=>r.vulns?.length?[{name:plan.packages[i].name,ids:r.vulns.map(v=>v.id)}]:[])}));
