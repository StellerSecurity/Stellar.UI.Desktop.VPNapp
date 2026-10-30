<?php
declare(strict_types=1);
// First-party, exact-site/hash guarded source overlay. Never installs dependencies or clears session cache.
ini_set('display_errors', '0');
$root = '/home/site/wwwroot'; $changed = []; $backup = null; $cached = false;
function androidProcess(array $args): string {
    $p = proc_open($args, [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, '/home/site/wwwroot');
    if (!is_resource($p)) throw new RuntimeException('process_failed');
    fclose($pipes[0]); $out = stream_get_contents($pipes[1]); fclose($pipes[1]);
    stream_get_contents($pipes[2]); fclose($pipes[2]);
    if (proc_close($p) !== 0) throw new RuntimeException('process_failed');
    return $out;
}
function androidPublish(string $source, string $target): void {
    if (!is_dir(dirname($target)) || is_link($target)) throw new RuntimeException('invalid_target');
    $temporary = tempnam(dirname($target), '.stellar-android-');
    if (!$temporary || !copy($source, $temporary) || !chmod($temporary, 0644) || !rename($temporary, $target)) throw new RuntimeException('publish_failed');
    if (function_exists('opcache_invalidate')) opcache_invalidate($target, true);
}
try {
    if (PHP_SAPI !== 'cli' || strtolower((string) getenv('WEBSITE_SITE_NAME')) !== 'stellar-desktop-vpn-staging-premium') throw new LogicException('wrong_site');
    $lock = fopen('/home/stellar-redemption-deployment.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) throw new LogicException('deployment_busy');
    $expected = $argv[1] ?? '';
    if (!preg_match('/^[a-f0-9]{64}$/D', $expected) || hash_file('sha256', __DIR__.'/payload.json') !== $expected) throw new LogicException('manifest_changed');
    $payload = json_decode(file_get_contents(__DIR__.'/payload.json'), true, 16, JSON_THROW_ON_ERROR);
    if (count($payload['files'] ?? []) !== 17) throw new LogicException('invalid_manifest');
    foreach ($payload['files'] as $file) {
        $path = $file['path'];
        if (!preg_match('#^(?:app/(?:Application|Domain|Infrastructure|Http/Controllers|Providers)/[A-Za-z/]+\.php|routes/api\.php)$#D', $path)
            || str_contains($path, '..') || is_link($root.'/'.$path)) throw new LogicException('invalid_path');
        $current = is_file($root.'/'.$path) ? hash_file('sha256', $root.'/'.$path) : null;
        if ($current !== $file['before']) throw new LogicException('baseline_changed:'.$path);
        $data = base64_decode($file['content'], true);
        if (!is_string($data) || hash('sha256', $data) !== $file['after']) throw new LogicException('payload_changed');
        $stage = __DIR__.'/source/'.$path;
        if (!is_dir(dirname($stage)) && !mkdir(dirname($stage), 0700, true)) throw new RuntimeException('stage_failed');
        if (file_put_contents($stage, $data) !== strlen($data)) throw new RuntimeException('stage_failed');
        androidProcess([PHP_BINARY, '-l', $stage]);
    }
    $loader = require $root.'/vendor/autoload.php';
    if ($loader->isClassMapAuthoritative()) throw new LogicException('authoritative_autoload');
    $app = require $root.'/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $cached = $app->routesAreCached();
    $beforeRoutes = json_decode(androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:list', '--json']), true, 512, JSON_THROW_ON_ERROR);
    $backup = '/home/stellar-android-login-backup-'.gmdate('Ymd-His').'-'.bin2hex(random_bytes(4));
    if (!mkdir($backup, 0700)) throw new RuntimeException('backup_failed');
    foreach ($payload['files'] as $file) if ($file['before'] !== null) {
        if (!is_dir(dirname($backup.'/'.$file['path']))) mkdir(dirname($backup.'/'.$file['path']), 0700, true);
        if (!copy($root.'/'.$file['path'], $backup.'/'.$file['path']) || !chmod($backup.'/'.$file['path'], 0600)) throw new RuntimeException('backup_failed');
    }
    // New contracts and classes first; route entry point last. Preserve all cache/session data.
    $ordered = $payload['files'];
    usort($ordered, fn ($a, $b) => ($a['path'] === 'routes/api.php' ? 2 : ($a['before'] === null ? 0 : 1)) <=> ($b['path'] === 'routes/api.php' ? 2 : ($b['before'] === null ? 0 : 1)));
    foreach ($ordered as $file) {
        androidPublish(__DIR__.'/source/'.$file['path'], $root.'/'.$file['path']); $changed[] = $file;
    }
    androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:clear', '--no-interaction']);
    if ($cached) androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:cache', '--no-interaction']);
    $afterRoutes = json_decode(androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:list', '--json']), true, 512, JSON_THROW_ON_ERROR);
    $keys = fn ($row) => $row['method'].' '.$row['uri'];
    $beforeKeys = array_map($keys, $beforeRoutes); $afterKeys = array_map($keys, $afterRoutes);
    if (array_diff($beforeKeys, $afterKeys) || array_values(array_diff($afterKeys, $beforeKeys)) !== ['POST api/v2/auth/account-login']) throw new LogicException('route_mismatch');
    foreach ($payload['files'] as $file) if (hash_file('sha256', $root.'/'.$file['path']) !== $file['after']) throw new RuntimeException('verification_failed');
    echo 'STELLAR_ANDROID_LOGIN_DEPLOYED '.json_encode(['files'=>17,'backup'=>$backup,'routeCache'=>$cached,'newRoutes'=>1,'sessionCachePreserved'=>true]).PHP_EOL;
} catch (Throwable $failure) {
    foreach (array_reverse($changed) as $file) {
        if ($file['before'] !== null && $backup && is_file($backup.'/'.$file['path'])) {
            try { androidPublish($backup.'/'.$file['path'], $root.'/'.$file['path']); } catch (Throwable) {}
        }
        // New unreachable classes remain recoverable; no destructive cleanup on failure.
    }
    if ($changed) {
        try {
            androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:clear', '--no-interaction']);
            if ($cached) androidProcess([PHP_BINARY, __DIR__.'/console.php', 'route:cache', '--no-interaction']);
        } catch (Throwable) {}
    }
    echo 'STELLAR_ANDROID_LOGIN_FAILED '.get_class($failure).' '.(str_starts_with($failure->getMessage(), 'baseline_changed:') ? $failure->getMessage() : '').PHP_EOL;
    exit(1);
}
