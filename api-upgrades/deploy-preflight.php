<?php
declare(strict_types=1);
// First-party read-only release preflight. No migrations, writes, HTTP calls or secret output.
ini_set('display_errors', '0');
$role = $argv[1] ?? '';
$sites = ['activation-license' => 'stellaractivationlicenseapiprod', 'subscriptions' => 'stellersubscriptionapiprod', 'desktop' => 'stellar-desktop-vpn-staging-premium'];
try {
    if (!isset($sites[$role]) || strtolower((string) getenv('WEBSITE_SITE_NAME')) !== $sites[$role]) throw new LogicException('wrong_release_target');
    $root = '/home/site/wwwroot';
    $loader = require $root.'/vendor/autoload.php';
    $app = require $root.'/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $files = match ($role) {
        'activation-license' => ['routes/api.php', 'app/Http/Kernel.php', 'app/Http/Controllers/V1/ActivationLicenseController.php', 'app/Models/ActivationLicense.php'],
        'subscriptions' => ['routes/api.php', 'app/Http/Kernel.php', 'app/Models/Subscription.php', 'app/Http/Controllers/v1/SubscriptionController.php'],
        'desktop' => ['routes/api.php', 'config/desktop-api.php', 'app/Providers/DesktopApiServiceProvider.php'],
    };
    $hashes = [];
    foreach ($files as $file) $hashes[$file] = is_file($root.'/'.$file) ? hash_file('sha256', $root.'/'.$file) : null;
    $out = ['role' => $role, 'php' => PHP_VERSION, 'laravel' => $app->version(), 'classmapAuthoritative' => $loader->isClassMapAuthoritative(), 'files' => $hashes];
    if ($role === 'subscriptions') {
        $credentials = require __DIR__.'/subscriptions/config/vpn-redemption.php';
        $out['activationCredentialsPresent'] = is_string($credentials['username']) && $credentials['username'] !== '' && is_string($credentials['password']) && $credentials['password'] !== '';
        unset($credentials);
    }
    if ($role === 'desktop') {
        $credentials = require __DIR__.'/desktop/config/desktop-api.php';
        $out['activationCredentialsPresent'] = is_string($credentials['activation_service_username']) && $credentials['activation_service_username'] !== '' && is_string($credentials['activation_service_password']) && $credentials['activation_service_password'] !== '';
        $out['subscriptionCredentialsPresent'] = is_string($credentials['subscription_service_username']) && $credentials['subscription_service_username'] !== '' && is_string($credentials['subscription_service_password']) && $credentials['subscription_service_password'] !== '';
        unset($credentials);
    } else {
        $connection = Illuminate\Support\Facades\DB::connection();
        $out['driver'] = $connection->getDriverName();
        if ($out['driver'] !== 'mysql') throw new LogicException('unexpected_database_driver');
        $baseTable = $role === 'activation-license' ? 'activationlicenses' : 'subscriptions';
        $meta = $connection->selectOne('SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [$baseTable]);
        $out['baseTableEngine'] = $meta->engine ?? null;
        $newTable = $role === 'activation-license' ? 'vpn_license_redemptions' : 'vpn_license_credits';
        $out['redemptionTableExists'] = Illuminate\Support\Facades\Schema::hasTable($newTable);
        $out['transactionSupportRequired'] = $out['baseTableEngine'] === 'InnoDB';
    }
    echo 'STELLAR_PREFLIGHT '.json_encode($out, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES).PHP_EOL;
} catch (Throwable $error) {
    // Never print connection errors, traces, config or environment values.
    echo 'STELLAR_PREFLIGHT_FAILED '.get_class($error).PHP_EOL;
    exit(1);
}
