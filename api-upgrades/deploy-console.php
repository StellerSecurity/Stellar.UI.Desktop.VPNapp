<?php
declare(strict_types=1);
// Deployment-only console entry outside webroot. Uses the already installed Laravel runtime.
ini_set('display_errors','0');
if (PHP_SAPI !== 'cli' || strtolower((string)getenv('WEBSITE_SITE_NAME')) !== 'stellar-desktop-vpn-staging-premium') exit(1);
define('LARAVEL_START',microtime(true));
require '/home/site/wwwroot/vendor/autoload.php';
$app=require '/home/site/wwwroot/bootstrap/app.php';
$kernel=$app->make(Illuminate\Contracts\Console\Kernel::class);
$input=new Symfony\Component\Console\Input\ArgvInput();
$status=$kernel->handle($input,new Symfony\Component\Console\Output\ConsoleOutput());
$kernel->terminate($input,$status);
exit($status);
