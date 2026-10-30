<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class); $kernel->bootstrap();
$http = $app->make(Illuminate\Http\Client\Factory::class); $http->preventStrayRequests();
$token = '7|'.str_repeat('A', 40); $scenario = 'valid'; $calls = []; $checks = 0;
function accountHttpCheck(bool $condition, string $name): void {
    global $checks;
    if (!$condition) throw new RuntimeException('Account HTTP failed: '.$name);
    $checks++;
}
$http->fake(function ($request) use (&$scenario, &$calls, $http) {
    $calls[] = $request;
    if (str_contains($request->url(), 'stellaruserapiprod.azurewebsites.net/')) {
        return $scenario === 'invalid-session' ? $http->response([], 401, ['Content-Type' => 'application/json'])
            : $http->response(['response_code' => 200, 'user' => ['id' => '42'], 'expires_at' => '2099-01-01T00:00:00Z'], 200, ['Content-Type' => 'application/json']);
    }
    if (str_contains($request->url(), 'stellersubscriptionapiprod.azurewebsites.net/')) {
        accountHttpCheck($request->method() === 'GET' && $request['user_id'] === '42' && $request['type'] === 1, 'only verified account and VPN type');
        $row = ['id' => 'verified-subscription', 'user_id' => 42, 'type' => 1, 'status' => 1, 'expires_at' => '2099-01-01T00:00:00Z'];
        if ($scenario === 'foreign-subscription') $row['user_id'] = 99;
        if ($scenario === 'pending') $row['meta'] = ['activate_on_login' => true, 'activated' => false];
        return $http->response($scenario === 'none' ? [] : [$row], $scenario === 'subscription-outage' ? 503 : 200, ['Content-Type' => 'application/json']);
    }
    if (str_contains($request->url(), 'stellardevicesapiprod.azurewebsites.net/')) {
        accountHttpCheck($request->method() === 'GET' && $request['identifier'] === 'verified-subscription', 'only verified subscription devices');
        return $http->response([['id' => 12, 'identifier' => $scenario === 'foreign-device' ? 'other-subscription' : 'verified-subscription', 'name' => 'Synthetic device']], $scenario === 'device-outage' ? 503 : 200, ['Content-Type' => 'application/json']);
    }
    throw new RuntimeException('Unexpected outbound request');
});
$app['config']->set(['desktop-api.identity' => 'user-api', 'desktop-api.user_service_username' => 'synthetic', 'desktop-api.user_service_password' => 'synthetic',
    'desktop-api.subscription_service_username' => 'synthetic', 'desktop-api.subscription_service_password' => 'synthetic',
    'desktop-api.device_service_username' => 'synthetic', 'desktop-api.device_service_password' => 'synthetic']);
(new Stellar\DesktopApi\Providers\DesktopApiServiceProvider($app))->register();
function accountCall(?string $bearer, int $status): array {
    global $app, $kernel;
    $app['cache']->flush();
    $server = ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json'];
    if ($bearer !== null) $server['HTTP_AUTHORIZATION'] = 'Bearer '.$bearer;
    // A hostile requested account ID MUST be ignored.
    $request = Illuminate\Http\Request::create('http://127.0.0.1/api/v2/account', 'POST', [], [], [], $server, '{"user_id":99,"subscription_id":"other-subscription"}');
    $response = $kernel->handle($request); $kernel->terminate($request, $response);
    accountHttpCheck($response->getStatusCode() === $status, 'response status');
    accountHttpCheck(str_contains($response->headers->get('Cache-Control', ''), 'no-store'), 'private account response not cached');
    $raw = $response->getContent();
    accountHttpCheck(!str_contains($raw, 'synthetic') && !str_contains($raw, 'access_token') && !str_contains($raw, 'Bearer'), 'no credentials or bearer echoed');
    return json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
}
try {
    accountCall(null, 401); accountCall('malformed', 401); accountHttpCheck(count($calls) === 0, 'missing/invalid tokens never reach upstream');
    $valid = accountCall($token, 200)['data'];
    accountHttpCheck($valid['account_id'] === '42' && $valid['subscription']['id'] === 'verified-subscription' && $valid['devices'][0]['id'] === '12', 'complete original account data');
    foreach (['none', 'subscription-outage', 'foreign-subscription', 'device-outage', 'foreign-device', 'pending', 'invalid-session'] as $scenario) {
        $before = count($calls); $data = accountCall($token, $scenario === 'invalid-session' ? 401 : 200)['data'] ?? null;
        if ($scenario === 'none') accountHttpCheck($data['subscription_state'] === 'none' && $data['devices_state'] === 'not_applicable' && count($calls) - $before === 2, 'no fabricated plan or device call');
        if (in_array($scenario, ['subscription-outage', 'foreign-subscription'], true)) accountHttpCheck($data['subscription_state'] === 'unavailable' && $data['subscription'] === null && count($calls) - $before === 2, 'subscription errors never leak or trigger foreign device lookup');
        if (in_array($scenario, ['device-outage', 'foreign-device'], true)) accountHttpCheck($data['subscription_state'] === 'available' && $data['devices_state'] === 'unavailable' && $data['devices'] === null, 'independent safe device failure');
        if ($scenario === 'pending') accountHttpCheck($data['subscription']['status'] === 'pending' && $data['subscription']['expires_at'] === null, 'viewing does not activate');
        if ($scenario === 'invalid-session') accountHttpCheck(count($calls) - $before === 1, 'invalid identity never reaches subscription/device services');
    }
    foreach ($calls as $call) accountHttpCheck(!preg_match('~/add|/delete|/find/|/patch|issue|activate_on_login~', $call->url()), 'no mutation operation');
    echo $checks.' account HTTP assertions passed; all upstream HTTP faked.'.PHP_EOL;
} catch (Throwable $error) { fwrite(STDERR, $error->getMessage().PHP_EOL); exit(1); }
