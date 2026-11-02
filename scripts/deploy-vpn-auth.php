<?php
declare(strict_types=1);
// First-party, staging-only two-file overlay. No credentials, dependencies or migrations.
ini_set('display_errors', '0');
$root = '/home/site/wwwroot';
$backup = null;
try {
    if (PHP_SAPI !== 'cli' || strtolower((string)getenv('WEBSITE_SITE_NAME')) !== 'stellar-desktop-vpn-staging-premium') throw new LogicException('wrong_site');
    $lock = fopen('/home/stellar-redemption-deployment.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) throw new LogicException('deployment_busy');
    $payload = json_decode(file_get_contents(__DIR__.'/payload.json'), true, 16, JSON_THROW_ON_ERROR);
    $route = $root.'/routes/api.php';
    if (is_link($route) || hash_file('sha256', $route) !== '58889e499e652e11c966f5e6f51fb84ee4220e1d6b3d7bafb478774c44f4db76') throw new LogicException('baseline_changed');
    $controller = $root.'/app/Http/Controllers/VpnAuthController.php';
    if (file_exists($controller) || is_link($controller)) throw new LogicException('controller_already_exists');
    $loader = require $root.'/vendor/autoload.php';
    if ($loader->isClassMapAuthoritative()) throw new LogicException('authoritative_autoload');
    foreach (['routes/api.php', 'app/Http/Controllers/VpnAuthController.php'] as $path) {
        $data = base64_decode($payload[$path]['content'], true);
        if (!is_string($data) || hash('sha256', $data) !== $payload[$path]['sha256']) throw new LogicException('payload_changed');
        $source = __DIR__.'/'.basename($path);
        file_put_contents($source, $data);
        exec(escapeshellarg(PHP_BINARY).' -l '.escapeshellarg($source).' 2>&1', $output, $status);
        if ($status !== 0) throw new LogicException('invalid_php');
    }
    $app = require $root.'/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $wasCached = $app->routesAreCached();
    $backup = '/home/stellar-vpn-auth-backup-'.gmdate('Ymd-His').'-'.bin2hex(random_bytes(4));
    if (!mkdir($backup, 0700) || !copy($route, $backup.'/api.php')) throw new RuntimeException('backup_failed');
    chmod($backup.'/api.php', 0600);
    foreach (['app/Http/Controllers/VpnAuthController.php', 'routes/api.php'] as $path) {
        $temp = tempnam(dirname($root.'/'.$path), '.stellar-vpn-auth-');
        if (!$temp || !copy(__DIR__.'/'.basename($path), $temp) || !chmod($temp, 0644) || !rename($temp, $root.'/'.$path)) throw new RuntimeException('publish_failed');
    }
    Illuminate\Support\Facades\Artisan::call('route:clear');
    if ($wasCached && Illuminate\Support\Facades\Artisan::call('route:cache') !== 0) throw new RuntimeException('route_cache_failed');
    foreach ($payload as $path => $file) if (hash_file('sha256', $root.'/'.$path) !== $file['sha256']) throw new RuntimeException('verification_failed');
    echo 'STELLAR_VPN_AUTH_DEPLOYED '.json_encode(['site'=>'stellar-desktop-vpn-staging-premium', 'files'=>2, 'backup'=>$backup, 'routeCache'=>$wasCached]).PHP_EOL;
} catch (Throwable $error) {
    if ($backup && is_file($backup.'/api.php')) {
        copy($backup.'/api.php', $root.'/routes/api.php');
        if (isset($app)) {
            Illuminate\Support\Facades\Artisan::call('route:clear');
            if ($wasCached ?? false) Illuminate\Support\Facades\Artisan::call('route:cache');
        }
    }
    echo 'STELLAR_VPN_AUTH_FAILED '.get_class($error).PHP_EOL;
    exit(1);
}
