<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class); $kernel->bootstrap();
$http = $app->make(Illuminate\Http\Client\Factory::class); $http->preventStrayRequests();
$scenario = 'valid'; $calls = []; $checks = 0;
$receipt = 'a0000000-0000-4000-8000-000000000001';
function actCheck(bool $value, string $name): void { global $checks; if (!$value) throw new RuntimeException($name); $checks++; }
$http->fake(function ($r) use ($http, &$scenario, &$calls, $receipt) {
    $calls[] = $r;
    if (str_contains($r->url(), 'stellaruserapiprod.')) return $http->response(['response_code' => 200, 'user' => ['id' => '42'], 'expires_at' => '2099-01-01T00:00:00Z'], $scenario === 'bad-session' ? 401 : 200, ['Content-Type' => 'application/json']);
    if (str_ends_with(explode('?', $r->url())[0], '/user/subscriptions')) {
        actCheck($r['user_id'] === '42' && $r['type'] === 1, 'verified account only');
        return $http->response($scenario === 'no-subscription' ? [] : [['id' => 'sub-42', 'user_id' => $scenario === 'foreign-subscription' ? 99 : 42, 'type' => 1, 'status' => 1, 'expires_at' => '2099-01-01T00:00:00Z']], 200, ['Content-Type' => 'application/json']);
    }
    if ($r->url() === 'https://stellaractivationlicenseapiprod.azurewebsites.net/api/v1/vpn-redemptions/claim') {
        actCheck($r->method() === 'POST' && $r['account_id'] === '42' && $r['subscription_id'] === 'sub-42' && $r['code'] === 'TEST-CODE', 'no caller-controlled ownership');
        return $http->response(['receipt_id' => $receipt, 'type' => 1, 'account_id' => '42', 'subscription_id' => $scenario === 'foreign-receipt' ? 'other' : 'sub-42'], $scenario === 'invalid-code' ? 409 : 200, ['Content-Type' => 'application/json']);
    }
    if ($r->url() === 'https://stellersubscriptionapiprod.azurewebsites.net/api/v1/subscriptioncontroller/license-credit') {
        actCheck($r->method() === 'POST' && $r['receipt_id'] === $receipt && !isset($r['days']), 'credit uses receipt not caller duration');
        return $http->response(['credited' => true, 'receipt_id' => $receipt], $scenario === 'credit-outage' ? 503 : 200, ['Content-Type' => 'application/json']);
    }
    throw new RuntimeException('Unexpected HTTP');
});
$app['config']->set(['desktop-api.identity' => 'user-api', 'desktop-api.activation_enabled' => true,
    'desktop-api.user_service_username' => 'synthetic', 'desktop-api.user_service_password' => 'synthetic',
    'desktop-api.subscription_service_username' => 'synthetic', 'desktop-api.subscription_service_password' => 'synthetic',
    'desktop-api.activation_service_username' => 'synthetic', 'desktop-api.activation_service_password' => 'synthetic']);
(new Stellar\DesktopApi\Providers\DesktopApiServiceProvider($app))->register();
function actCall(?string $token, array $data, int $status): array {
    global $app, $kernel;
    $app['cache']->flush();
    $headers = ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json'];
    if ($token) $headers['HTTP_AUTHORIZATION'] = 'Bearer '.$token;
    $request = Illuminate\Http\Request::create('http://127.0.0.1/api/v2/account/activation', 'POST', [], [], [], $headers, json_encode($data));
    $response = $kernel->handle($request); $kernel->terminate($request, $response);
    actCheck($response->status() === $status, 'HTTP status '.$status);
    actCheck(str_contains($response->headers->get('Cache-Control', ''), 'no-store'), 'no caching');
    actCheck(!preg_match('/TEST-CODE|synthetic|Bearer|receipt_id/', $response->getContent()), 'no secrets or internal receipt exposed');
    return json_decode($response->getContent(), true, 16, JSON_THROW_ON_ERROR);
}
try {
    $token = '7|'.str_repeat('A', 40); $input = ['activation_code' => 'TEST-CODE', 'account_id' => '99', 'subscription_id' => 'hostile', 'days' => 999];
    actCall(null, $input, 401); actCall($token, ['activation_code' => '<script>'], 422);
    actCheck(count($calls) === 0, 'no upstream for invalid input');
    $app['config']->set('desktop-api.activation_enabled', false); actCall($token, $input, 503);
    actCheck(count($calls) === 0, 'disabled rollout cannot consume code');
    $app['config']->set('desktop-api.activation_enabled', true);
    actCheck(actCall($token, $input, 200)['data']['activated'] === true && count($calls) === 4, 'verified complete flow');
    foreach (['bad-session' => 401, 'no-subscription' => 409, 'foreign-subscription' => 503, 'invalid-code' => 409, 'foreign-receipt' => 503, 'credit-outage' => 503] as $scenario => $status) {
        $before = count($calls); actCall($token, $input, $status);
        $expected = match ($scenario) { 'bad-session' => 1, 'no-subscription', 'foreign-subscription' => 2, 'invalid-code', 'foreign-receipt' => 3, default => 4 };
        actCheck(count($calls) - $before === $expected, 'fail closed without blind retries');
    }
    echo "$checks activation HTTP assertions passed; all upstream HTTP faked.\n";
} catch (Throwable $e) { fwrite(STDERR, $e->getMessage()."\n"); exit(1); }
