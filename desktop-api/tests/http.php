<?php
declare(strict_types=1);
// Executes Laravel only AFTER separate runtime installation/execution approval.
if (!is_file(dirname(__DIR__).'/vendor/autoload.php')) {
    fwrite(STDERR, "HTTP tests require the separately approved Laravel runtime.\n");
    exit(1);
}
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') {
    fwrite(STDERR, "HTTP tests require explicit testing/fixture mode.\n");
    exit(1);
}
try {
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$kernel->bootstrap();
Illuminate\Support\Facades\Http::preventStrayRequests();
$count = 0;
function expect(bool $value, string $name): void {
    global $count;
    if (!$value) throw new RuntimeException('HTTP contract failed: '.$name);
    $count++;
}
function callApi(string $method, string $path, int $status, ?array $body = null, ?string $bearer = null, bool $outsideV2 = false, bool $retrySafe = false): array {
    global $kernel;
    $server = ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json'];
    if ($bearer !== null) $server['HTTP_AUTHORIZATION'] = 'Bearer '.$bearer;
    $request = Illuminate\Http\Request::create('http://127.0.0.1'.($outsideV2 ? '' : '/api/v2').$path, $method, [], [], [], $server,
        $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR));
    $response = $kernel->handle($request);
    if ($response->getStatusCode() !== $status) {
        $error = $response->exception ?? null;
        fwrite(STDERR, 'Unexpected status '.$response->getStatusCode().' for '.$method.' '.$path.PHP_EOL);
        if ($error) fwrite(STDERR, get_class($error).': '.$error->getMessage().PHP_EOL);
    }
    expect($response->getStatusCode() === $status, $method.' '.$path.' status '.$status);
    $data = json_decode($response->getContent(), true, 512, JSON_THROW_ON_ERROR);
    expect(($data['meta']['api_version'] ?? null) === 'v2', 'v2 envelope');
    expect(($data['meta']['mode'] ?? null) === 'fixture', 'fixture marker');
    expect(preg_match('/^[a-f0-9]{32}$/D', $data['meta']['request_id'] ?? '') === 1, 'request ID shape');
    expect($response->headers->get('X-Request-ID') === $data['meta']['request_id'], 'request ID header matches envelope');
    expect(str_contains($response->headers->get('Cache-Control', ''), 'no-store'), 'no-store');
    expect(($response->headers->get('X-Stellar-Retry-Safe') === 'not-executed') === $retrySafe, 'only pre-execution rejections allow mutation retry');
    if ($retrySafe) expect(is_numeric($response->headers->get('Retry-After')), 'safe retry retains limiter Retry-After');
    expect(!str_contains($response->getContent(), 'fixture-secret-password'), 'password never echoed');
    if ($status >= 400) expect(isset($data['error']['code'], $data['error']['message']) && !isset($data['data']), 'error envelope');
    $kernel->terminate($request, $response);
    return $data;
}

if (in_array('--prove-failure-exit', $argv, true)) expect(false, 'intentional failure-exit self-test');

$health = callApi('GET', '/health', 200);
expect($health['data']['ready'] === false && $health['data']['vpn_connected'] === false, 'no false readiness/VPN claims');
$servers = callApi('GET', '/servers', 200);
expect(count($servers['data']) === 58, '58 test locations');
expect(!isset($servers['data'][0]['config_url']), 'no fake working VPN configuration');
$filtered = callApi('GET', '/servers?country=DK', 200);
expect(count($filtered['data']) > 0 && count(array_filter($filtered['data'], fn ($s) => $s['country_code'] !== 'DK')) === 0, 'country filter');
expect(callApi('GET', '/servers?country=ZZ', 200)['data'] === [], 'empty result is a list');
callApi('GET', '/servers?country=invalid', 422);
callApi('GET', '/servers?country[]=DK', 422);
callApi('POST', '/auth/login', 422, []);
callApi('POST', '/auth/login', 422, ['username' => [], 'password' => 'fixture-secret-password']);
callApi('POST', '/auth/login', 422, ['username' => 'fixture@example.test', 'password' => str_repeat('x', 1025)]);
expect(callApi('POST', '/auth/login', 503, ['username' => 'fixture@example.test', 'password' => 'fixture-secret-password'])['error']['code'] === 'integration_unavailable', 'unconfigured identity fails closed');
callApi('POST', '/auth/logout', 401);
callApi('POST', '/auth/logout', 401, [], 'fixture-token');
$testToken = '1|'.str_repeat('A', 40);
expect(callApi('POST', '/auth/logout', 503, [], $testToken)['error']['code'] === 'integration_unavailable', 'no fake revocation success');
callApi('POST', '/auth/register', 422, []);
callApi('POST', '/auth/register', 422, ['username' => 'fixture@example.test', 'password' => 'short']);
callApi('POST', '/auth/register', 422, ['username' => 'not-email', 'password' => 'fixture-secret-password']);
callApi('POST', '/auth/register', 503, ['username' => 'fixture@example.test', 'password' => 'fixture-secret-password']);
callApi('POST', '/auth/session', 401);
callApi('POST', '/auth/session', 401, [], 'malformed');
callApi('POST', '/auth/session', 503, [], $testToken);

// Exercise the complete controller -> use case -> shared SDK path using fake HTTP only.
$http = $app->make(Illuminate\Http\Client\Factory::class);
$http->fake(['stellaruserapiprod.azurewebsites.net/*' => Illuminate\Support\Facades\Http::sequence()
    ->push(['response_code' => 200, 'token' => $testToken, 'token_type' => 'Bearer', 'expires_at' => '2099-01-01T00:00:00Z', 'user' => ['id' => '1']], 200)
    ->push(['response_code' => 200, 'token' => $testToken, 'token_type' => 'Bearer', 'expires_at' => '2099-01-01T00:00:00Z', 'user' => ['id' => '1']], 200)
    ->push(['response_code' => 200, 'expires_at' => '2099-01-01T00:00:00Z', 'user' => ['id' => '1']], 200)
    ->push(['response_code' => 200, 'revoked' => true], 200)
    ->push(['private' => 'must-not-leak'], 401)
    ->push(['private' => 'must-not-leak'], 409)
    ->push([], 429)
    ->push([], 503)]);
$app['config']->set(['desktop-api.identity' => 'user-api', 'desktop-api.user_service_username' => 'synthetic-service',
    'desktop-api.user_service_password' => 'synthetic-password']);
(new Stellar\DesktopApi\Providers\DesktopApiServiceProvider($app))->register();
$app['cache']->flush();
foreach ($app['router']->getRoutes() as $route) $route->flushController();
$input = ['username' => 'fixture@example.test', 'password' => 'fixture-secret-password'];
expect(callApi('POST', '/auth/login', 200, $input)['data']['access_token'] === $testToken, 'login SDK token');
expect(callApi('POST', '/auth/register', 200, array_replace($input, ['password' => '123456']))['data']['account_id'] === '1', 'register SDK account accepts six characters');
$session = callApi('POST', '/auth/session', 200, [], $testToken);
expect(!isset($session['data']['access_token']) && $session['data']['account_id'] === '1', 'restore does not echo token');
expect(callApi('POST', '/auth/logout', 200, [], $testToken)['data']['revoked'] === true, 'logout SDK revocation');
expect(callApi('POST', '/auth/login', 401, $input)['error']['code'] === 'invalid_credentials', 'login rejection mapped');
expect(callApi('POST', '/auth/register', 409, $input)['error']['code'] === 'registration_unavailable', 'registration rejection mapped');
expect(callApi('POST', '/auth/login', 429, $input)['error']['code'] === 'rate_limited', 'rate limit mapped');
expect(callApi('POST', '/auth/login', 503, $input)['error']['code'] === 'integration_unavailable', 'upstream unavailable mapped');
$app['cache']->flush();
for ($attempt = 0; $attempt < 10; $attempt++) callApi('POST', '/auth/login', 422, []);
expect(callApi('POST', '/auth/login', 429, [], null, false, true)['error']['code'] === 'rate_limited', 'credential rate limiter enforced');
$app['cache']->flush();
foreach (['tauri://localhost' => true, 'https://evil.example' => false] as $origin => $allowed) {
    $request = Illuminate\Http\Request::create('http://127.0.0.1/api/v2/auth/login', 'OPTIONS', [], [], [],
        ['HTTP_ORIGIN' => $origin, 'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST', 'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'Content-Type']);
    $response = $kernel->handle($request);
    expect(($response->headers->get('Access-Control-Allow-Origin') === $origin) === $allowed, 'restricted desktop CORS');
    $kernel->terminate($request, $response);
}
callApi('GET', '/unknown', 404);
callApi('POST', '/servers', 405);
callApi('GET', '/.env', 404, null, null, true);
callApi('GET', '/vendor/autoload.php', 404, null, null, true);
callApi('GET', '/api/v1/vpncontroller/server-list', 404, null, null, true);
expect(count($http->recorded()) === 8, 'exactly eight fake requests, no live requests');
echo $count.' Laravel HTTP assertions passed without real accounts or upstream requests.'.PHP_EOL;
} catch (\Throwable $failure) {
    fwrite(STDERR, 'HTTP tests failed: '.$failure->getMessage().PHP_EOL);
    exit(1);
}
