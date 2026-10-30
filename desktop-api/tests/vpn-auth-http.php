<?php
declare(strict_types=1);
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') exit(1);
require dirname(__DIR__).'/vendor/autoload.php';
$app = require dirname(__DIR__).'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class); $kernel->bootstrap();
$app->make(Illuminate\Http\Client\Factory::class)->preventStrayRequests();
use Stellar\DesktopApi\Application\Ports\ScopedIdentityGateway;
use Stellar\DesktopApi\Application\Ports\IdentityGateway;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\VpnCredentialGateway;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;
use Stellar\DesktopApi\Domain\Subscription;
use Stellar\DesktopApi\Domain\VpnCredentials;
$checks = 0;
function authCheck(bool $ok, string $name): void { global $checks; if (!$ok) throw new RuntimeException($name); $checks++; }
$identity = new class implements ScopedIdentityGateway {
    public bool $revoked = false;
    public function issueSession(LoginCredentials $credentials): Session { throw new RuntimeException('No password login allowed'); }
    public function registerSession(LoginCredentials $credentials): Session { throw new RuntimeException('No registration allowed'); }
    public function revokeSession(string $accessToken): void { throw new RuntimeException('No logout allowed'); }
    public function inspectSession(string $token): Session {
        if ($this->revoked) throw new IdentityRejected('invalid_session', 401);
        return new Session($token, '42', new DateTimeImmutable('2099-01-01'));
    }
};
$subscriptions = new class implements SubscriptionGateway {
    public ?Subscription $value = null;
    public function forAccount(string $accountId): ?Subscription { authCheck($accountId === '42', 'verified account only'); return $this->value; }
};
$issuer = new class implements VpnCredentialGateway {
    public int $calls = 0; public bool $outage = false;
    public function issueForLogin(string $accountId, string $subscriptionId): VpnCredentials {
        authCheck($accountId === '42' && $subscriptionId === 'verified-sub', 'caller ownership ignored');
        $this->calls++;
        if ($this->outage) throw new IntegrationUnavailable('synthetic private detail');
        return new VpnCredentials('stvpn_'.str_repeat('a', 16), str_repeat('b', 32), '3ff114ac-7a0c-4f9e-b064-f9fe67e38ae3');
    }
};
$app->instance(IdentityGateway::class, $identity);
$app->instance(SubscriptionGateway::class, $subscriptions);
$app->instance(VpnCredentialGateway::class, $issuer);
$app['config']->set('desktop-api.vpn_login', true);
function authCall(?string $token, int $expected): array {
    global $kernel, $app;
    $app['cache']->flush();
    $headers = ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json'];
    if ($token) $headers['HTTP_AUTHORIZATION'] = 'Bearer '.$token;
    $request = Illuminate\Http\Request::create('http://127.0.0.1/api/v2/vpn/auth', 'POST', [], [], [], $headers,
        json_encode(['account_id'=>'99', 'subscription_id'=>'foreign', 'device_id'=>'hostile']));
    $response = $kernel->handle($request); $kernel->terminate($request, $response);
    authCheck($response->status() === $expected, 'HTTP status '.$expected);
    authCheck(str_contains($response->headers->get('Cache-Control', ''), 'no-store'), 'no secret response caching');
    authCheck(!str_contains($response->getContent(), 'synthetic private detail'), 'no upstream exception leaked');
    return json_decode($response->getContent(), true, 16, JSON_THROW_ON_ERROR);
}
try {
    $token = '7|'.str_repeat('A', 40);
    authCall(null, 401); authCall('invalid', 401);
    $app['config']->set('desktop-api.vpn_login', false); authCall($token, 503);
    $app['config']->set('desktop-api.vpn_login', true);
    foreach ([null, new Subscription('verified-sub', 'inactive', null), new Subscription('verified-sub', 'pending', null),
        new Subscription('verified-sub', 'active', new DateTimeImmutable('2000-01-01'))] as $sub) {
        $subscriptions->value = $sub;
        authCheck(authCall($token, 403)['error']['code'] === 'subscription_required', 'inactive is not logout');
    }
    authCheck($issuer->calls === 0, 'no ineligible device creation');
    foreach (['active', 'trial'] as $status) {
        $subscriptions->value = new Subscription('verified-sub', $status, new DateTimeImmutable('2099-01-01'));
        $data = authCall($token, 200)['data'];
        authCheck($data['vpn_state'] === 'ready' && $data['vpn_auth']['password'] === str_repeat('b', 32), 'eligible post-activation setup');
        authCheck(!isset($data['access_token']), 'no session reissue or extension');
    }
    $identity->revoked = true; authCall($token, 401); authCheck($issuer->calls === 2, 'revoked login never issues');
    $identity->revoked = false; $issuer->outage = true;
    authCall($token, 503); authCheck($issuer->calls === 3, 'ambiguous mutation is not retried');
    echo "$checks VPN auth HTTP assertions passed; no external requests.\n";
} catch (Throwable $error) { fwrite(STDERR, $error->getMessage()."\n"); exit(1); }
