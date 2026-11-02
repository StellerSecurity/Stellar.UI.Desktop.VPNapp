<?php
declare(strict_types=1);
// Source-only, site/hash guarded deployment. Never print config, exception messages or secrets.
ini_set('display_errors', '0');
$role = $argv[1] ?? '';
$mode = $argv[2] ?? 'check';
$root = '/home/site/wwwroot';
$sites = ['activation-license'=>'stellaractivationlicenseapiprod', 'subscriptions'=>'stellersubscriptionapiprod', 'desktop'=>'stellar-desktop-vpn-staging-premium'];
$changed = []; $backup = null; $app = null; $dbLock = false;
function process(array $args): string {
    // Earlier desktop bundles have no artisan entrypoint. Do not change their web bootstrap.
    if (($args[1]??null)==='/home/site/wwwroot/artisan' && !is_file($args[1])) $args[1]=__DIR__.'/console.php';
    $pipes = [];
    $p = proc_open($args, [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, '/home/site/wwwroot');
    if (!is_resource($p)) throw new RuntimeException('process_failed');
    fclose($pipes[0]); $out = stream_get_contents($pipes[1]); fclose($pipes[1]);
    stream_get_contents($pipes[2]); fclose($pipes[2]);
    if (proc_close($p) !== 0) throw new RuntimeException('command_failed');
    return $out;
}
function publish(string $source, string $target): void {
    if (is_link($target)) throw new LogicException('symlink_target');
    if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0755, true)) throw new RuntimeException('mkdir_failed');
    $temp = tempnam(dirname($target), '.stellar-release-');
    if (!$temp || !copy($source, $temp) || !chmod($temp, 0644) || !rename($temp, $target)) throw new RuntimeException('publish_failed');
}
try {
    if (!isset($sites[$role]) || strtolower((string)getenv('WEBSITE_SITE_NAME')) !== $sites[$role] || !in_array($mode,['check','apply'],true)) throw new LogicException('wrong_target');
    $lock = fopen('/home/stellar-redemption-deployment.lock','c');
    if (!$lock || !flock($lock, LOCK_EX|LOCK_NB)) throw new LogicException('deployment_busy');
    $manifest = json_decode(file_get_contents(__DIR__.'/manifest.json'), true, 32, JSON_THROW_ON_ERROR)[$role];
    foreach ($manifest['files'] as $file) {
        $path = $file['path'];
        if (!preg_match('~^[a-zA-Z0-9_./-]+\.php$~D',$path) || str_contains($path,'..')) throw new LogicException('invalid_path');
        $source = __DIR__.'/'.$role.'/'.$path; $target = $root.'/'.$path;
        if (!is_file($source) || is_link($source) || hash_file('sha256',$source) !== $file['after']) throw new LogicException('payload_mismatch');
        $current = file_exists($target) ? hash_file('sha256',$target) : null;
        $leftoverNewClass = $file['before']===null && $current===$file['after'];
        if (is_link($target) || ($current !== $file['before'] && !$leftoverNewClass)) throw new LogicException('live_baseline_mismatch');
        process([PHP_BINARY,'-l',$source]);
    }
    $loader = require $root.'/vendor/autoload.php';
    $app = require $root.'/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    if ($loader->isClassMapAuthoritative()) throw new LogicException('authoritative_autoload_unsupported');
    $routeCache = $app->routesAreCached(); $configCache = $app->configurationIsCached();
    $routeCount = count($app['router']->getRoutes());
    if ($role !== 'desktop') {
        $db = Illuminate\Support\Facades\DB::connection();
        if ($db->getDriverName() !== 'mysql') throw new LogicException('mysql_required');
        $db->statement('SET SESSION innodb_lock_wait_timeout = 10');
        $db->statement('SET SESSION lock_wait_timeout = 10');
        $engine = $db->selectOne('SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',[$manifest['baseTable']]);
        if (($engine->engine??null) !== 'InnoDB') throw new LogicException('innodb_required');
        if (Illuminate\Support\Facades\Schema::hasTable($manifest['table'])) throw new LogicException('receipt_table_already_exists_requires_review');
        $dbLock = (int)($db->selectOne("SELECT GET_LOCK('stellar-vpn-redemption-deploy',0) AS acquired")->acquired??0) === 1;
        if (!$dbLock) throw new LogicException('database_deployment_busy');
    }
    if ($role === 'subscriptions' || $role === 'desktop') {
        $credentials = require __DIR__.'/'.$role.'/config/'.($role==='desktop'?'desktop-api.php':'vpn-redemption.php');
        $u = $credentials[$role==='desktop'?'activation_service_username':'username'];
        $p = $credentials[$role==='desktop'?'activation_service_password':'password'];
        if (!is_string($u)||$u===''||!is_string($p)||$p==='') throw new LogicException('activation_credentials_missing');
        unset($credentials,$u,$p);
    }
    echo 'STELLAR_RELEASE_CHECK '.json_encode(['role'=>$role,'files'=>count($manifest['files']),'legacyRouteCount'=>$routeCount,'routeCache'=>$routeCache,'configCache'=>$configCache,'ready'=>true],JSON_THROW_ON_ERROR).PHP_EOL;
    if ($mode === 'apply') {
        $backup = '/home/stellar-redemption-backups/'.gmdate('Ymd-His').'-'.$role.'-'.bin2hex(random_bytes(4));
        if (!mkdir($backup,0700,true)) throw new RuntimeException('backup_failed');
        foreach ($manifest['files'] as $file) {
            $path=$file['path'];
            if ($file['before']!==null) {
                if (!is_dir(dirname($backup.'/'.$path))) mkdir(dirname($backup.'/'.$path),0700,true);
                if (!copy($root.'/'.$path,$backup.'/'.$path)) throw new RuntimeException('backup_failed');
                chmod($backup.'/'.$path,0600);
            }
        }
        file_put_contents($backup.'/manifest.json',json_encode($manifest,JSON_THROW_ON_ERROR)); chmod($backup.'/manifest.json',0600);
        // New unreachable classes/config/migration first. Existing entry points are published last.
        foreach ($manifest['files'] as $file) if ($file['before']===null) {
            publish(__DIR__.'/'.$role.'/'.$file['path'],$root.'/'.$file['path']); $changed[]=$file;
        }
        if ($role!=='desktop') {
            $migration=$root.'/'.$manifest['migration'];
            process([PHP_BINARY,$root.'/artisan','migrate','--force','--realpath','--path='.$migration,'--no-interaction']);
            $engine=$db->selectOne('SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',[$manifest['table']]);
            if (($engine->engine??null)!=='InnoDB') throw new LogicException('receipt_table_must_be_innodb');
        }
        foreach ($manifest['files'] as $file) if ($file['before']!==null) {
            publish(__DIR__.'/'.$role.'/'.$file['path'],$root.'/'.$file['path']); $changed[]=$file;
        }
        process([PHP_BINARY,$root.'/artisan','config:clear','--no-interaction']);
        process([PHP_BINARY,$root.'/artisan','route:clear','--no-interaction']);
        if ($configCache) process([PHP_BINARY,$root.'/artisan','config:cache','--no-interaction']);
        if ($routeCache) process([PHP_BINARY,$root.'/artisan','route:cache','--no-interaction']);
        foreach ($manifest['files'] as $file) if(hash_file('sha256',$root.'/'.$file['path'])!==$file['after']) throw new RuntimeException('post_publish_mismatch');
        $routeJson = process([PHP_BINARY,$root.'/artisan','route:list','--json']);
        $routes=json_decode($routeJson,true,512,JSON_THROW_ON_ERROR);
        if (count($routes)!==$routeCount+count($manifest['routes'])) throw new LogicException('unexpected_route_count');
        foreach ($manifest['routes'] as $uri) {
            $match=array_values(array_filter($routes,fn($r)=>($r['uri']??'')===$uri&&($r['method']??'')==='POST'));
            if(count($match)!==1) throw new LogicException('new_route_missing');
        }
        echo 'STELLAR_RELEASE_APPLIED '.json_encode(['role'=>$role,'backup'=>$backup,'files'=>count($changed),'receiptHistoryRetained'=>true],JSON_THROW_ON_ERROR).PHP_EOL;
    }
} catch(Throwable $error) {
    if ($backup && $changed) {
        foreach(array_reverse($changed) as $file) {
            // Keep additive classes and immutable receipt migrations/history. Restore only prior entry points.
            if($file['before']!==null) publish($backup.'/'.$file['path'],$root.'/'.$file['path']);
        }
        try {
            process([PHP_BINARY,$root.'/artisan','config:clear','--no-interaction']);
            process([PHP_BINARY,$root.'/artisan','route:clear','--no-interaction']);
            if($configCache??false) process([PHP_BINARY,$root.'/artisan','config:cache','--no-interaction']);
            if($routeCache??false) process([PHP_BINARY,$root.'/artisan','route:cache','--no-interaction']);
        } catch(Throwable) { echo 'STELLAR_RELEASE_CACHE_REPAIR_REQUIRED'.PHP_EOL; }
        echo 'STELLAR_RELEASE_ENTRYPOINTS_RESTORED'.PHP_EOL;
    }
    echo 'STELLAR_RELEASE_FAILED '.get_class($error).PHP_EOL;
    exit(1);
} finally {
    if($dbLock) Illuminate\Support\Facades\DB::connection()->selectOne("SELECT RELEASE_LOCK('stellar-vpn-redemption-deploy')");
}
