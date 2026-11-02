// First-party security review: JSON and individual source files as inert text.
// Does not download archives/binaries, import vendor code, or execute package scripts.
import fs from 'node:fs';
import crypto from 'node:crypto';
const lockPath = '.security-review/user-api-upgrade-resolution/composer.lock';
const bytes = fs.readFileSync(lockPath);
const lock = JSON.parse(bytes);
const old = JSON.parse(fs.readFileSync('.security-review/user-api/composer.lock'));
const previous = JSON.parse(fs.readFileSync('.security-review/api-v2-runtime-source.json'));
const direct = JSON.parse(fs.readFileSync('.security-review/user-api-upgrade-candidates.json'));
const evidence = [...previous.packages, ...direct.packages];
const packages = [...lock.packages, ...lock['packages-dev']];
const report = {date:new Date().toISOString(), lockSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
 scope:'Focused manifest/autoload/source review; not full code or executable certification; no installation approval', packages:[], errors:[]};
const samples = {
 'carbonphp/carbon-doctrine-types':['src/Carbon/Doctrine/DateTimeType.php'],
 'doctrine/inflector':['src/Inflector.php'], 'doctrine/lexer':['src/AbstractLexer.php'],
 'dragonmantank/cron-expression':['src/Cron/CronExpression.php'],
 'graham-campbell/result-type':['src/Success.php'],
 'guzzlehttp/promises':['src/Promise.php'], 'guzzlehttp/psr7':['src/Uri.php'],
 'guzzlehttp/uri-template':['src/UriTemplate.php'],
 'laravel/prompts':['src/Prompt.php'], 'laravel/serializable-closure':['src/Serializers/Native.php'],
 'league/commonmark':['src/Extension/Attributes/Util/AttributesHelper.php'],
 'league/flysystem':['src/WhitespacePathNormalizer.php'],
 'league/flysystem-local':['LocalFilesystemAdapter.php'],
 'league/mime-type-detection':['src/FinfoMimeTypeDetector.php'],
 'league/uri':['Uri.php'], 'league/uri-interfaces':['Contracts/UriInterface.php'],
 'monolog/monolog':['src/Monolog/Logger.php','src/Monolog/Handler/SocketHandler.php'],
 'nesbot/carbon':['src/Carbon/Carbon.php'], 'nette/schema':['src/Schema/Processor.php'],
 'nette/utils':['src/Utils/Json.php'], 'nikic/php-parser':['lib/PhpParser/ParserFactory.php'],
 'phpoption/phpoption':['src/PhpOption/Option.php'], 'psy/psysh':['src/Configuration.php','src/Shell.php'],
 'ramsey/uuid':['src/Uuid.php'],
 'symfony/clock':['Clock.php'], 'symfony/console':['Application.php'],
 'symfony/css-selector':['CssSelectorConverter.php'], 'symfony/error-handler':['ErrorHandler.php'],
 'symfony/event-dispatcher':['EventDispatcher.php'], 'symfony/finder':['Finder.php'],
 'symfony/http-kernel':['HttpKernel.php'], 'symfony/mailer':['Mailer.php'], 'symfony/mime':['Email.php'],
 'symfony/process':['Process.php'], 'symfony/routing':['Route.php'],
 'symfony/service-contracts':['ResetInterface.php'], 'symfony/string':['UnicodeString.php'],
 'symfony/translation':['Translator.php'], 'symfony/uid':['Uuid.php'],
 'symfony/var-dumper':['VarDumper.php'], 'symfony/yaml':['Yaml.php'],
 'vlucas/phpdotenv':['src/Dotenv.php'],
 'fakerphp/faker':['src/Faker/Generator.php'], 'laravel/pint':['app/Commands/DefaultCommand.php'],
 'mockery/mockery':['library/Mockery.php','library/Mockery/Loader/EvalLoader.php'],
 'filp/whoops':['src/Whoops/Run.php'], 'hamcrest/hamcrest-php':['hamcrest/Hamcrest/Matcher.php'],
 'myclabs/deep-copy':['src/DeepCopy/DeepCopy.php'],
 'phar-io/manifest':['src/values/Manifest.php'], 'phar-io/version':['src/Version.php'],
 'phpunit/php-code-coverage':['src/CodeCoverage.php'], 'phpunit/php-file-iterator':['src/Factory.php'],
 'phpunit/php-invoker':['src/Invoker.php'], 'phpunit/php-text-template':['src/Template.php'],
 'phpunit/php-timer':['src/Timer.php'],
 'sebastian/cli-parser':['src/Parser.php'], 'sebastian/code-unit':['src/CodeUnit.php'],
 'sebastian/code-unit-reverse-lookup':['src/Wizard.php'], 'sebastian/comparator':['src/Factory.php'],
 'sebastian/complexity':['src/Calculator.php'], 'sebastian/diff':['src/Differ.php'],
 'sebastian/environment':['src/Runtime.php'], 'sebastian/exporter':['src/Exporter.php'],
 'sebastian/global-state':['src/Snapshot.php'], 'sebastian/lines-of-code':['src/Counter.php'],
 'sebastian/object-enumerator':['src/Enumerator.php'], 'sebastian/object-reflector':['src/ObjectReflector.php'],
 'sebastian/recursion-context':['src/Context.php'], 'sebastian/type':['src/type/Type.php'],
 'sebastian/version':['src/Version.php'], 'spatie/backtrace':['src/Backtrace.php'],
 'spatie/error-solutions':['src/SolutionProviderRepository.php'],
 'spatie/flare-client-php':['src/Flare.php'], 'spatie/ignition':['src/Ignition.php'],
 'staabm/side-effects-detector':['lib/SideEffectsDetector.php'], 'theseer/tokenizer':['src/Tokenizer.php'],
 'stellarsecurity/laravel-hardening':['src/Providers/StellarHardeningServiceProvider.php'],
};
const pattern = /\b(?:exec|execSync|spawn|spawnSync|shell_exec|system|passthru|proc_open|popen|eval|base64_decode|getenv|unserialize|file_get_contents|file_put_contents)\s*\(|child_process|Function\s*\(|LaunchAgents|LaunchDaemons|launchctl|\.ssh|\.gnupg|\.aws|\.azure|Login Data|PRIVATE.KEY|https?:\/\//i;
async function read(url,options={}) {
 if (!['packagist.org','raw.githubusercontent.com','api.osv.dev','api.github.com'].includes(new URL(url).hostname)) throw Error('Unexpected origin');
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
 if(!r.ok) throw Error(`HTTP ${r.status}: ${url}`);
 return r.text();
}
const checkpoint = () => fs.writeFileSync('.security-review/user-api-upgrade-lock-review.json',JSON.stringify(report,null,2));
for(let offset=0;offset<packages.length;offset+=4) {
 await Promise.all(packages.slice(offset,offset+4).map(async p=>{
  const row={name:p.name,version:p.version,source:p.source,description:p.description,dev:!lock.packages.includes(p),
   oldVersion:[...old.packages,...old['packages-dev']].find(q=>q.name===p.name)?.version,files:[]};
  try {
   const registry=JSON.parse(await read(`https://packagist.org/packages/${p.name}.json`)).package;
   const version=Object.values(registry.versions).find(q=>q.version.replace(/^v/,'')===p.version.replace(/^v/,''));
   row.registry={created:registry.time,repository:registry.repository,maintainers:registry.maintainers,downloads:registry.downloads,
    release:version?.time,sourceMatches:version?.source?.reference===p.source.reference,
    history:Object.values(registry.versions).filter(q=>/^v?\d+\.\d+\.\d+$/.test(q.version)).slice(0,5).map(q=>({version:q.version,time:q.time}))};
   if(!row.registry.sourceMatches) throw Error('Registry/pinned commit mismatch');
   const reused=evidence.find(q=>q.name===p.name&&q.source?.reference===p.source.reference&&q.manifest&&q.files?.some(f=>f.source));
   if(reused){row.manifest=reused.manifest;row.files=reused.files;row.reusedExactSource=true;}
   else {
    const match=p.source.url.match(/^https:\/\/github.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if(!match||!/^[a-f0-9]{40}$/.test(p.source.reference)) throw Error('Unrecognized pinned source');
    const base=`https://raw.githubusercontent.com/${match[1]}/${p.source.reference}/`;
    row.manifest=JSON.parse(await read(base+'composer.json'));
    const files=[...new Set([...(row.manifest.autoload?.files||[]),...(samples[p.name]||[])])];
    for(const path of files){
     if(path.startsWith('/')||path.includes('..'))throw Error('Unsafe source path');
     try{const source=await read(base+path);row.files.push({path,source,hits:source.split('\n').flatMap((line,i)=>pattern.test(line)?[{line:i+1,text:line.trim().slice(0,400)}]:[])});}
     catch(error){row.files.push({path,error:error.message});}
    }
   }
   row.scripts=row.manifest.scripts||{};
   row.bin=row.manifest.bin||[];
   if(!row.files.some(f=>f.source))report.errors.push({name:p.name,error:'No representative source reviewed'});
   for(const f of row.files.filter(f=>f.error))report.errors.push({name:p.name,path:f.path,error:f.error});
  }catch(error){row.error=error.message;report.errors.push({name:p.name,error:error.message});}
  report.packages.push(row);
 }));
 checkpoint();console.log(`Reviewed metadata/source ${Math.min(offset+4,packages.length)}/${packages.length}`);
}
report.osv=JSON.parse(await read('https://api.osv.dev/v1/querybatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({queries:packages.map(p=>({package:{name:p.name,ecosystem:'Packagist'},version:p.version.replace(/^v/,'')}))})}));
report.osvOrder=packages.map(({name,version})=>({name,version}));
report.github={reviewed:[],malware:[],unreviewed:[]};
for(const type of Object.keys(report.github))for(let offset=0;offset<packages.length;offset+=25){
 const url=new URL('https://api.github.com/advisories');url.searchParams.set('ecosystem','composer');url.searchParams.set('type',type);url.searchParams.set('per_page','100');
 url.searchParams.set('affects',packages.slice(offset,offset+25).map(p=>`${p.name}@${p.version.replace(/^v/,'')}`).join(','));
 const items=JSON.parse(await read(url.href,{headers:{accept:'application/vnd.github+json'}}));
 if(items.length>=100)throw Error('Advisory pagination required');report.github[type].push(...items);
}
checkpoint();console.log(JSON.stringify({packages:report.packages.length,errors:report.errors,osv:report.osv.results.flatMap((r,i)=>r.vulns?.length?[{...report.osvOrder[i],ids:r.vulns.map(v=>v.id)}]:[]),github:Object.fromEntries(Object.entries(report.github).map(([k,v])=>[k,v.map(a=>a.ghsa_id)]))}));
