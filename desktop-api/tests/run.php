<?php
declare(strict_types=1);
require dirname(__DIR__).'/bootstrap/first-party-autoload.php';

use Stellar\DesktopApi\Application\AuthService;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\ServerService;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Server;
use Stellar\DesktopApi\Domain\Session;
use Stellar\DesktopApi\Infrastructure\FixtureServerCatalog;
use Stellar\DesktopApi\Infrastructure\StagingPolicy;
use Stellar\DesktopApi\Infrastructure\UnavailableIdentityGateway;

$passed = 0;
function check(bool $condition, string $name): void {
    global $passed;
    if (!$condition) throw new RuntimeException('FAIL: '.$name);
    $passed++; echo 'PASS: '.$name.PHP_EOL;
}
function rejects(callable $callback, string $type, string $name): void {
    try { $callback(); } catch (Throwable $error) { check($error instanceof $type, $name); return; }
    throw new RuntimeException('FAIL: '.$name.' did not reject');
}

$root = dirname(__DIR__);
$catalog = new FixtureServerCatalog($root.'/fixtures/servers.json');
$servers = (new ServerService($catalog))->list();
check(count($servers) === 58, '58 fixture servers, no upstream requests');
check(count(array_unique(array_map(fn ($s) => $s->id, $servers))) === 58, 'server IDs unique');
$dk = (new ServerService($catalog))->list('DK');
check(count($dk) > 0 && count(array_filter($dk, fn ($s) => $s->countryCode !== 'DK')) === 0, 'country filtering');
check((new ServerService($catalog))->list('ZZ') === [], 'unknown country yields empty list');
rejects(fn () => (new ServerService($catalog))->list('dk'), InvalidArgumentException::class, 'invalid filter rejected');
rejects(fn () => new Server('invalid!', 'Name', 'DK', 0, 0), InvalidArgumentException::class, 'invalid ID rejected');
rejects(fn () => new Server('valid', 'Name', 'DK', NAN, 0), InvalidArgumentException::class, 'non-finite coordinates rejected');
rejects(fn () => new Server('valid', 'Name', 'DK', 91, 0), InvalidArgumentException::class, 'out-of-range coordinates rejected');
rejects(fn () => new LoginCredentials('', 'test-only'), InvalidArgumentException::class, 'empty login rejected');
rejects(fn () => new LoginCredentials('test@example.test', str_repeat('x', 1025)), InvalidArgumentException::class, 'oversized password rejected');
$credentials = new LoginCredentials('test@example.test', 'fixture-password');
ob_start(); var_dump($credentials); $debug = ob_get_clean();
check(!str_contains($debug, 'fixture-password') && !str_contains($debug, 'test@example.test'), 'credential debug output redacted');
check(!str_contains(json_encode($credentials, JSON_THROW_ON_ERROR), 'fixture-password'), 'password excluded from accidental JSON serialization');
$session = new Session('fixture-token', 'fixture-account', new DateTimeImmutable('2030-01-01T00:00:00Z'));
ob_start(); var_dump($session); $debug = ob_get_clean();
check(!str_contains($debug, 'fixture-token'), 'token debug output redacted');
check(!str_contains(json_encode($session, JSON_THROW_ON_ERROR), 'fixture-token'), 'token excluded from accidental JSON serialization');
$auth = new AuthService(new UnavailableIdentityGateway());
rejects(fn () => $auth->login($credentials), IntegrationUnavailable::class, 'unconfigured login never succeeds');
rejects(fn () => $auth->logout('1|'.str_repeat('a', 40)), IntegrationUnavailable::class, 'unconfigured logout never claims revocation');
rejects(fn () => $auth->logout(''), IdentityRejected::class, 'empty token rejected');
rejects(fn () => $auth->register($credentials), IntegrationUnavailable::class, 'unconfigured registration never creates accounts');
rejects(fn () => $auth->inspect('1|'.str_repeat('a', 40)), IntegrationUnavailable::class, 'unconfigured introspection never validates tokens');
StagingPolicy::assertFixtureMode('testing', 'fixture', null);
StagingPolicy::assertFixtureMode('staging', 'fixture', 'stellar-desktop-vpn-staging');
check(true, 'explicit testing/staging fixture mode accepted');
rejects(fn () => StagingPolicy::assertFixtureMode('production', 'fixture', null), RuntimeException::class, 'production fixture boot refused');
rejects(fn () => StagingPolicy::assertFixtureMode('staging', 'live', null), RuntimeException::class, 'unimplemented live mode refused');
rejects(fn () => StagingPolicy::assertFixtureMode('staging', 'fixture', 'some-other-app'), RuntimeException::class, 'wrong Azure app refused');
echo $passed.' first-party tests passed; Laravel/vendor code was not loaded.'.PHP_EOL;
