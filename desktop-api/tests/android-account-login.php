<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
$app = new \Illuminate\Foundation\Application(dirname(__DIR__));
$app->instance('config', new \Illuminate\Config\Repository());
use Illuminate\Http\Client\Factory;
use Illuminate\Cache\Repository;
use Illuminate\Cache\ArrayStore;
use Stellar\DesktopApi\Infrastructure\AnonymousAccountGateway;
use Stellar\DesktopApi\Infrastructure\UserApiIdentityGateway;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
$checks = 0;
function androidCheck(bool $ok): void { global $checks; if (!$ok) throw new RuntimeException('Android compatibility assertion failed at check '.($checks + 1).'.'); $checks++; }
function androidReject(callable $call, string $type): void {
    try { $call(); } catch (Throwable $failure) { androidCheck($failure instanceof $type && $failure->getPrevious() === null); return; }
    throw new RuntimeException('Expected Android compatibility rejection.');
}
try {
    $number = '0000000000000042'; $token = '1|'.str_repeat('a', 40);
    $owner = ['id' => $number, 'user_id' => 42, 'type' => 1, 'status' => 1];
    $user = ['response_code' => 200, 'user' => ['id' => 42], 'token' => $token];
    $metadata = ['response_code' => 200, 'token' => ['id' => 1, 'tokenable_id' => 42, 'tokenable_type' => 'App\\Models\\User',
        'name' => 'Stellar.VPN', 'abilities' => ['vpn'], 'created_at' => gmdate('Y-m-d\TH:i:s\Z'), 'expires_at' => null]];
    $http = new Factory(); $http->preventStrayRequests();
    $outage = false;
    $http->fake(function ($request) use ($http, &$owner, &$user, &$metadata, &$outage) {
        if ($outage) throw new RuntimeException('Synthetic secret must not escape.');
        return $http->response(json_encode(str_contains($request->url(), 'subscriptioncontroller') ? $owner
            : (str_contains($request->url(), 'personaltokencontroller') ? $metadata : $user)), 200, ['Content-Type' => 'application/json']);
    });
    $cache = new Repository(new ArrayStore());
    $make = fn () => new UserApiIdentityGateway($http, 'synthetic', 'identity-password',
        new AnonymousAccountGateway($http, 'synthetic', 'subscription-password'), $cache);
    $gateway = $make();
    $session = $gateway->issueAnonymousSession($number);
    androidCheck($session->accountId === '42' && $session->accessToken() === $token);
    androidCheck($session->subscriptionHash === hash('sha256', $number));
    androidCheck(abs($session->expiresAt->getTimestamp() - time() - 86400) < 3);
    androidCheck(count($http->recorded()) === 3);
    $requests = $http->recorded();
    androidCheck(str_contains($requests[0][0]->url(), '/subscriptioncontroller/find/'.$number) && $requests[0][0]['type'] === 1);
    androidCheck(str_ends_with($requests[1][0]->url(), '/usercontroller/user/42'));
    androidCheck(str_contains($requests[2][0]->url(), '/personaltokencontroller/'.rawurlencode($token)));
    foreach ($requests as [$request]) androidCheck($request->method() === 'GET' && $request->hasHeader('Authorization'));
    $cacheRows = $cache->getStore()->all();
    androidCheck(!str_contains(json_encode($cacheRows), $token) && !str_contains(json_encode($cacheRows), $number));
    androidCheck($make()->inspectSession($token)->expiresAt == $session->expiresAt);
    androidCheck($make()->inspectSession($token)->subscriptionHash === $session->subscriptionHash);
    $outage = true;
    androidReject(fn () => $gateway->inspectSession($token), IntegrationUnavailable::class);
    $outage = false;
    androidCheck($gateway->inspectSession($token)->accountId === '42');
    $metadata['token']['abilities'] = ['*'];
    androidReject(fn () => $gateway->inspectSession($token), IdentityRejected::class);
    $metadata['token']['abilities'] = ['vpn'];
    $metadata['token']['tokenable_id'] = 99;
    androidReject(fn () => $gateway->inspectSession($token), IdentityRejected::class);
    $metadata['token']['tokenable_id'] = 42;
    $metadata['token']['expires_at'] = '2000-01-01T00:00:00Z';
    androidReject(fn () => $gateway->inspectSession($token), IdentityRejected::class);
    $metadata['token']['expires_at'] = null;
    $metadata['token']['created_at'] = gmdate('Y-m-d\TH:i:s\Z', time() - 90000);
    androidReject(fn () => $gateway->inspectSession($token), IdentityRejected::class);
    $metadata['token']['created_at'] = gmdate('Y-m-d\TH:i:s\Z');
    $gateway->revokeSession($token); $make()->revokeSession($token);
    $before = count($http->recorded());
    androidReject(fn () => $make()->inspectSession($token), IdentityRejected::class);
    androidCheck(count($http->recorded()) === $before);
    foreach (['abc', '123', '12345678901234567'] as $invalid) androidReject(fn () => $gateway->issueAnonymousSession($invalid), IdentityRejected::class);
    androidCheck(count($http->recorded()) === $before);
    unset($user['token']);
    androidReject(fn () => $gateway->issueAnonymousSession($number), IdentityRejected::class);
    foreach ([null, [...$owner, 'type' => 2], [...$owner, 'id' => '0000000000000043']] as $bad) {
        $owner = $bad;
        androidReject(fn () => $gateway->issueAnonymousSession($number), IdentityRejected::class);
    }
    echo $checks.' Android-compatible login/session assertions passed; fake HTTP and in-memory cache only.'.PHP_EOL;
} catch (Throwable $failure) { fwrite(STDERR, get_class($failure).': '.$failure->getMessage().PHP_EOL); exit(1); }
