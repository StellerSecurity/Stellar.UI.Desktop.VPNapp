<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Infrastructure\SubscriptionApiGateway;
use Stellar\DesktopApi\Application\IntegrationUnavailable;

$count = 0;
function accountCheck(bool $value, string $name): void {
    global $count;
    if (!$value) throw new RuntimeException('Account test failed: '.$name);
    $count++;
}
function rejectAccount(callable $call): void {
    try { $call(); } catch (Throwable) { accountCheck(true, 'invalid data rejected'); return; }
    throw new RuntimeException('Invalid data accepted');
}
try {
    $row = ['id' => 'real-subscription', 'user_id' => 42, 'type' => 1, 'status' => 1, 'expires_at' => '2099-01-01T00:00:00.000000Z'];
    accountCheck(SubscriptionApiGateway::decode([$row], '42')?->status === 'active', 'real status');
    accountCheck(SubscriptionApiGateway::decode([], '42') === null, 'no subscription distinct from outage');
    accountCheck(SubscriptionApiGateway::decode([$row, [...$row, 'id' => 'newer']], '42')?->id === 'real-subscription', 'legacy first subscription retained');
    $selected = hash('sha256', 'selected-anonymous-plan');
    $rows = [$row, [...$row, 'id' => 'selected-anonymous-plan', 'status' => 0]];
    accountCheck(SubscriptionApiGateway::decode($rows, '42', $selected)?->status === 'inactive', 'anonymous session cannot borrow another owned active plan');
    accountCheck(SubscriptionApiGateway::decode([$row], '42', $selected) === null, 'missing selected plan never falls back to first');
    rejectAccount(fn () => SubscriptionApiGateway::decode([$row, [...$row, 'id' => 'selected-anonymous-plan', 'user_id' => 99]], '42', $selected));
    accountCheck(SubscriptionApiGateway::decode([[...$row, 'expires_at' => '2000-01-01 00:00:00']], '42')?->status === 'expired', 'UTC expiry');
    accountCheck(SubscriptionApiGateway::decode([[...$row, 'expires_at' => null]], '42')?->expiresAt === null, 'no invented expiry');
    $pending = SubscriptionApiGateway::decode([[...$row, 'meta' => ['activate_on_login' => true, 'activated' => false]]], '42');
    accountCheck($pending?->status === 'pending' && $pending->expiresAt === null, 'deferred subscription not activated or misreported');
    foreach (['user_id' => 99, 'type' => 0, 'status' => 4, 'id' => true, 'expires_at' => '2099-02-30T00:00:00Z'] as $key => $value) rejectAccount(fn () => SubscriptionApiGateway::decode([[...$row, $key => $value]], '42'));
    rejectAccount(fn () => SubscriptionApiGateway::decode(['error' => 'private'], '42'));
    foreach ([200, 401, 302, 503] as $status) {
        $http = new Factory(); $http->preventStrayRequests();
        $http->fake(['stellersubscriptionapiprod.azurewebsites.net/*' => $http->response([$row], $status, ['Content-Type' => 'application/json'])]);
        $gateway = new SubscriptionApiGateway($http, 'synthetic-service', 'synthetic-password');
        if ($status === 200) accountCheck($gateway->forAccount('42')?->id === 'real-subscription', 'read-only adapter');
        else {
            try { $gateway->forAccount('42'); throw new RuntimeException('Expected unavailable'); }
            catch (IntegrationUnavailable $error) { accountCheck($error->getPrevious() === null, 'safe unchained outage'); }
        }
        accountCheck(count($http->recorded()) === 1, 'one read, no retry');
        $request = $http->recorded()[0][0];
        accountCheck($request->method() === 'GET' && $request['user_id'] === '42' && $request['type'] === 1, 'authenticated account filter and VPN type');
        accountCheck(!str_contains($request->url(), 'find/') && !str_contains($request->url(), 'activate'), 'no mutating activation endpoint');
    }
    $deviceRow = ['id' => 12, 'identifier' => 'real-subscription', 'name' => 'Synthetic device', 'private' => 'must-not-pass-through'];
    $devices = \Stellar\DesktopApi\Infrastructure\DeviceApiGateway::decode([$deviceRow], 'real-subscription');
    accountCheck($devices === [['id' => '12', 'name' => 'Synthetic device']], 'allowlisted device DTO');
    accountCheck(count(\Stellar\DesktopApi\Infrastructure\DeviceApiGateway::decode([[...$deviceRow, 'id' => '3ff114ac-7a0c-4f9e-b064-f9fe67e38ae3']], 'real-subscription')) === 1, 'actual DeviceLogin UUID model accepted');
    rejectAccount(fn () => \Stellar\DesktopApi\Infrastructure\DeviceApiGateway::decode([[...$deviceRow, 'identifier' => 'foreign']], 'real-subscription'));
    rejectAccount(fn () => \Stellar\DesktopApi\Infrastructure\DeviceApiGateway::decode([$deviceRow, $deviceRow], 'real-subscription'));
    rejectAccount(fn () => \Stellar\DesktopApi\Infrastructure\DeviceApiGateway::decode([[...$deviceRow, 'name' => "bad\nname"]], 'real-subscription'));
    echo $count.' account adapter assertions passed; fake HTTP only.'.PHP_EOL;
} catch (Throwable $error) { fwrite(STDERR, $error->getMessage().PHP_EOL); exit(1); }
