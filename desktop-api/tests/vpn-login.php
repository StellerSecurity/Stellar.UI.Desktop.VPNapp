<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\VpnLoginService;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\VpnCredentialGateway;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Domain\Session;
use Stellar\DesktopApi\Domain\Subscription;
use Stellar\DesktopApi\Domain\VpnCredentials;
use Stellar\DesktopApi\Infrastructure\VpnCredentialApiGateway;

$checks = 0;
function vpnCheck(bool $condition, string $name): void {
    global $checks;
    if (!$condition) throw new RuntimeException('VPN login test failed: '.$name);
    $checks++;
}
try {
    $id = '3ff114ac-7a0c-4f9e-b064-f9fe67e38ae3';
    $username = 'stvpn_'.str_repeat('a', 16); $password = str_repeat('b', 32);
    $scenario = 'valid'; $calls = []; $names = [];
    $http = new Factory(); $http->preventStrayRequests();
    $http->fake(function ($request) use (&$scenario, &$calls, &$names, $http, $id, $username, $password) {
        $calls[] = $request;
        vpnCheck($request->method() === 'POST', 'mutations use POST');
        if ($request->url() === 'https://stellardevicesapiprod.azurewebsites.net/api/v1/devicecontroller/add') {
            vpnCheck($request['identifier'] === 'verified-subscription', 'verified subscription only');
            $pool = json_decode(file_get_contents(dirname(__DIR__).'/resources/device-names.json'), true, 4, JSON_THROW_ON_ERROR)['names'];
            vpnCheck(in_array($request['name'], $pool, true), 'same friendly names as legacy StellarDevice randomName');
            vpnCheck(!str_starts_with($request['name'], 'Desktop-'), 'no synthetic desktop hex label');
            $names[] = $request['name'];
            return $http->response(['id' => $id, 'identifier' => $scenario === 'foreign' ? 'foreign' : $request['identifier'], 'name' => $request['name']], $scenario === 'device-outage' ? 503 : 200, ['Content-Type' => 'application/json']);
        }
        vpnCheck($request->url() === 'https://stellarvpnapiprod.azurewebsites.net/api/v1/vpncredentialcontroller/credentials', 'pinned credential endpoint');
        vpnCheck($request['user_id'] === 42 && $request['device_id'] === $id, 'verified account and fresh device');
        return $http->response(['response_code' => 200, 'data' => ['username' => $username, 'password' => $scenario === 'no-password' ? null : $password]], $scenario === 'redirect' ? 302 : 200, ['Content-Type' => 'application/json']);
    });
    $gateway = new VpnCredentialApiGateway($http, 'synthetic-device', 'synthetic', 'synthetic-vpn', 'synthetic');
    for ($i = 0; $i < 2; $i++) {
        $secret = $gateway->issueForLogin('42', 'verified-subscription');
        vpnCheck($secret->forLoginResponse() === ['username' => $username, 'password' => $password, 'device_id' => $id], 'one-time response');
        vpnCheck(!str_contains(print_r($secret, true), $password), 'debug redacts password');
    }
    vpnCheck(count($names) === 2, 'each login registers a device; display names need not be unique');
    foreach (['foreign', 'device-outage', 'no-password', 'redirect'] as $scenario) {
        $before = count($calls);
        try { $gateway->issueForLogin('42', 'verified-subscription'); throw new RuntimeException('Expected failure'); }
        catch (IntegrationUnavailable $error) { vpnCheck($error->getPrevious() === null, 'no secret-bearing exception chain'); }
        vpnCheck(count($calls) - $before === (in_array($scenario, ['foreign', 'device-outage'], true) ? 1 : 2), 'no retry and no issue for invalid device');
    }
    $before = count($calls);
    try { (new VpnCredentialApiGateway($http, 'synthetic', 'synthetic', '', ''))->issueForLogin('42', 'verified-subscription'); }
    catch (IntegrationUnavailable) {}
    vpnCheck(count($calls) === $before, 'missing credentials never create orphan device');
    $subscriptions = new class implements SubscriptionGateway {
        public ?Subscription $value = null;
        public function forAccount(string $accountId): ?Subscription { vpnCheck($accountId === '42', 'session-bound account'); return $this->value; }
    };
    $issuer = new class($id, $username, $password) implements VpnCredentialGateway {
        public int $calls = 0;
        public function __construct(private string $id, private string $username, private string $password) {}
        public function issueForLogin(string $accountId, string $subscriptionId): VpnCredentials { $this->calls++; return new VpnCredentials($this->username, $this->password, $this->id); }
    };
    $service = new VpnLoginService($subscriptions, $issuer);
    $session = new Session('synthetic-session', '42', new DateTimeImmutable('2099-01-01'));
    foreach ([null, new Subscription('verified-subscription', 'expired', new DateTimeImmutable('2000-01-01')),
        new Subscription('verified-subscription', 'pending', null), new Subscription('verified-subscription', 'inactive', null),
        new Subscription('verified-subscription', 'active', new DateTimeImmutable('2000-01-01'))] as $sub) {
        $subscriptions->value = $sub;
        vpnCheck($service->provision($session) === null && $issuer->calls === 0, 'ineligible subscription never creates device or credentials');
    }
    $subscriptions->value = new Subscription('verified-subscription', 'active', new DateTimeImmutable('2099-01-01'));
    vpnCheck($service->provision($session) instanceof VpnCredentials && $issuer->calls === 1, 'active subscription provisions once');
    echo $checks.' VPN login assertions passed; all HTTP faked.'.PHP_EOL;
} catch (Throwable $error) { fwrite(STDERR, $error->getMessage().PHP_EOL); exit(1); }
