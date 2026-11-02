<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class); $kernel->bootstrap();
$http = $app->make(Illuminate\Http\Client\Factory::class); $http->preventStrayRequests();
$number = '0000000000000042'; $token = '1|'.str_repeat('a', 40); $reject = false;
$http->fake(function ($request) use ($http, $number, $token, &$reject) {
    if (str_contains($request->url(), 'subscriptioncontroller/find/')) {
        return $http->response(['id' => $number, 'user_id' => 42, 'type' => 1], 200, ['Content-Type' => 'application/json']);
    }
    if (str_contains($request->url(), '/personaltokencontroller/')) return $http->response(['response_code' => 200,
        'token' => ['id' => 1, 'tokenable_id' => 42, 'tokenable_type' => 'App\\Models\\User', 'name' => 'Stellar.VPN', 'abilities' => ['vpn'],
            'created_at' => gmdate('Y-m-d\TH:i:s\Z'), 'expires_at' => null]], 200, ['Content-Type' => 'application/json']);
    if (!str_ends_with($request->url(), '/usercontroller/user/42')) throw new RuntimeException('Unexpected identity request.');
    return $http->response(['response_code' => 200, 'user' => ['id' => 42]] + ($reject ? [] : ['token' => $token]), 200, ['Content-Type' => 'application/json']);
});
$app->instance(Stellar\DesktopApi\Application\Ports\IdentityGateway::class,
    new Stellar\DesktopApi\Infrastructure\UserApiIdentityGateway($http, 'synthetic', 'password',
        new Stellar\DesktopApi\Infrastructure\AnonymousAccountGateway($http, 'synthetic', 'password'), $app->make('cache.store')));
$app['config']->set('desktop-api.vpn_login', false);
$app['cache']->flush();
function anonymousHttp(array $body, int $expected): array {
    global $kernel;
    $request = Illuminate\Http\Request::create('http://localhost/api/v2/auth/account-login', 'POST', [], [], [],
        ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '127.0.0.42'], json_encode($body));
    $response = $kernel->handle($request); $kernel->terminate($request, $response);
    if ($response->status() !== $expected || !str_contains($response->headers->get('Cache-Control', ''), 'no-store')) throw new RuntimeException('Anonymous HTTP contract failed: '.$response->status());
    return json_decode($response->getContent(), true, 16, JSON_THROW_ON_ERROR);
}
foreach ([[], ['account_number' => []], ['account_number' => 'abc'], ['account_number' => '123']] as $bad) anonymousHttp($bad, 422);
if (count($http->recorded()) !== 0) throw new RuntimeException('Invalid input reached upstream.');
$reply = anonymousHttp(['account_number' => $number, 'user_id' => '99', 'role' => 2, 'expires_at' => '2099-01-01'], 200);
if (($reply['data']['account_id'] ?? null) !== '42' || ($reply['data']['access_token'] ?? null) !== $token) throw new RuntimeException('Invalid session contract.');
$reject = true;
if (anonymousHttp(['account_number' => $number], 401)['error']['code'] !== 'invalid_credentials') throw new RuntimeException('Rejection changed.');
for ($i = 0; $i < 4; $i++) anonymousHttp(['account_number' => 'abc'], 422);
anonymousHttp(['account_number' => $number], 429);
echo 'Anonymous HTTP validation, owner binding, scoped session, rejection and throttling verified; fake HTTP only.'.PHP_EOL;
