<?php
declare(strict_types=1);

define('LARAVEL_START', microtime(true));
$root = dirname(__DIR__);
if (!is_file($root.'/vendor/autoload.php')) {
    http_response_code(503);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo '{"error":{"code":"runtime_unavailable","message":"The API runtime is not installed."}}';
    exit;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->handleRequest(Illuminate\Http\Request::capture());
