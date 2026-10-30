<?php
declare(strict_types=1);
// Reviewed existing runtime only. No application boot, .env, real accounts or HTTP.
if (getenv('APP_ENV') !== 'testing') { fwrite(STDERR, "Explicit testing mode required.\n"); exit(1); }
require dirname(__DIR__).'/vendor/autoload.php';

use Illuminate\Http\Client\Factory;
use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Infrastructure\UserApiIdentityGateway;
use Stellar\DesktopApi\Infrastructure\ScopedUserApiClient;

// Supply only an empty config container for the SDK constructor; never bootstrap.
$app = new Application(dirname(__DIR__));
$app->instance('config', new Repository());

$count = 0;
function identityCheck(bool $value, string $name): void {
    global $count;
    if (!$value) throw new RuntimeException('Identity test failed: '.$name);
    $count++;
}
function identityRejects(callable $call, string $type, string $name): void {
    try { $call(); } catch (Throwable $error) {
        identityCheck($error instanceof $type, $name);
        identityCheck(!str_contains((string) $error, 'synthetic-service-password') && $error->getPrevious() === null, 'safe unchained failure');
        return;
    }
    throw new RuntimeException('Expected rejection: '.$name);
}
function gateway(mixed $body, int $status = 200, string $contentType = 'application/json'): array {
    $http = new Factory();
    $http->preventStrayRequests();
    if ($contentType !== 'application/json' && is_array($body)) $body = json_encode($body, JSON_THROW_ON_ERROR);
    $http->fake(['https://stellaruserapiprod.azurewebsites.net/api/v1/sessioncontroller/*' => $http->response($body, $status, ['Content-Type' => $contentType])]);
    return [new UserApiIdentityGateway($http, 'synthetic-service', 'synthetic-service-password'), $http];
}

try {
    $token = '123|'.str_repeat('a', 40);
    $expiry = (new DateTimeImmutable('+1 day'))->format(DATE_ATOM);
    $ok = ['response_code' => 200, 'token' => $token, 'token_type' => 'Bearer', 'expires_at' => $expiry, 'user' => ['id' => '42']];
    $credentials = new LoginCredentials('synthetic@example.test', 'synthetic-user-password');
    identityCheck(is_subclass_of(ScopedUserApiClient::class, \StellarSecurity\UserApiLaravel\UserApiClient::class), 'uses installed shared SDK');
    [$client, $http] = gateway($ok);
    $session = $client->issueSession($credentials);
    identityCheck($session->accountId === '42' && $session->accessToken() === $token, 'maps scoped session');
    $request = $http->recorded()[0][0];
    identityCheck($request->url() === 'https://stellaruserapiprod.azurewebsites.net/api/v1/sessioncontroller/login', 'fixed direct User API path');
    identityCheck($request->method() === 'POST', 'uses POST');
    identityCheck($request->data() === ['username' => 'synthetic@example.test', 'password' => 'synthetic-user-password'], 'sends no client-controlled expiry or scope');
    identityCheck($request->hasHeader('Authorization', 'Basic '.base64_encode('synthetic-service:synthetic-service-password')), 'service auth stays in header');
    identityCheck(!str_contains(json_encode($client), 'synthetic-service-password'), 'no accidental JSON secret serialization');
    ob_start(); var_dump($client); $debug = ob_get_clean();
    identityCheck(!str_contains($debug, 'synthetic-service-password'), 'debug redacted');

    $transport = new Factory();
    $transport->preventStrayRequests();
    $optionsSeen = [];
    $transport->fake(function ($request, $options) use ($transport, $ok, &$optionsSeen) {
        $optionsSeen = $options;
        return $transport->response($ok);
    });
    (new UserApiIdentityGateway($transport, 'synthetic-service', 'synthetic-service-password'))->issueSession($credentials);
    foreach (['allow_redirects' => false, 'http_errors' => false, 'verify' => true, 'stream' => true, 'connect_timeout' => 5, 'timeout' => 15] as $key => $value) {
        identityCheck(($optionsSeen[$key] ?? null) === $value, 'transport constraint '.$key);
    }
    $transport = new Factory();
    $transport->preventStrayRequests();
    $transport->fake(fn () => throw new RuntimeException('synthetic-service-password must not escape'));
    $unavailable = new UserApiIdentityGateway($transport, 'synthetic-service', 'synthetic-service-password');
    identityRejects(fn () => $unavailable->issueSession($credentials), IntegrationUnavailable::class, 'transport failure sanitized');
    $transport = new Factory();
    $transport->preventStrayRequests();
    $transport->fake(fn () => $transport->response('', 401, ['WWW-Authenticate' => 'Basic realm="Access denied"']));
    $unavailable = new UserApiIdentityGateway($transport, 'synthetic-service', 'synthetic-service-password');
    identityRejects(fn () => $unavailable->issueSession($credentials), IntegrationUnavailable::class, 'service authentication failure is not a user password error');

    [$client, $http] = gateway($ok);
    $client->registerSession(new LoginCredentials('synthetic@example.test', '123456'));
    identityCheck(str_ends_with($http->recorded()[0][0]->url(), '/register'), 'registration has separate operation');
    identityRejects(fn () => $client->registerSession(new LoginCredentials('synthetic@example.test', '12345')), IdentityRejected::class, '6-character registration minimum');
    identityCheck(count($http->recorded()) === 1, 'invalid registration never sent');

    [$client, $http] = gateway(['response_code' => 200, 'expires_at' => $expiry, 'user' => ['id' => '42']]);
    identityCheck($client->inspectSession($token)->accessToken() === $token, 'introspection retains supplied session');
    identityCheck($http->recorded()[0][0]->data() === ['token' => $token], 'token in POST body, never URL');
    [$client, $http] = gateway(['response_code' => 200, 'revoked' => true]);
    $client->revokeSession($token);
    identityCheck(str_ends_with($http->recorded()[0][0]->url(), '/logout'), 'server revocation');
    identityRejects(fn () => $client->inspectSession('invalid-token'), IdentityRejected::class, 'invalid token rejected locally');
    identityCheck(count($http->recorded()) === 1, 'invalid token never sent');

    foreach ([401, 409, 422, 429] as $status) {
        [$client, $http] = gateway(['error' => 'must not leak'], $status);
        try { $client->issueSession($credentials); throw new RuntimeException('Expected typed failure'); }
        catch (IdentityRejected $error) { identityCheck($error->httpStatus === $status, 'typed upstream status '.$status); }
        identityCheck(count($http->recorded()) === 1, 'no automatic retry '.$status);
    }
    foreach ([301, 302, 403, 500, 503] as $status) {
        [$client, $http] = gateway($ok, $status);
        identityRejects(fn () => $client->issueSession($credentials), IntegrationUnavailable::class, 'fails closed '.$status);
        identityCheck(count($http->recorded()) === 1, 'single request '.$status);
    }
    $invalid = [array_replace($ok, ['token_type' => 'other']), array_replace($ok, ['token' => 'not-a-token']),
        array_replace($ok, ['expires_at' => '2000-01-01T00:00:00Z']), array_replace($ok, ['expires_at' => '2030-02-30T00:00:00Z']),
        array_replace($ok, ['user' => ['id' => 42]]), array_replace($ok, ['response_code' => 400]), 'not-json', str_repeat('x', 65537)];
    foreach ($invalid as $body) {
        [$client] = gateway($body);
        identityRejects(fn () => $client->issueSession($credentials), IntegrationUnavailable::class, 'malformed/expired response rejected');
    }
    [$client] = gateway($ok, 200, 'text/html');
    identityRejects(fn () => $client->issueSession($credentials), IntegrationUnavailable::class, 'non-JSON refused');
    [$client] = gateway(['response_code' => 200, 'revoked' => false]);
    identityRejects(fn () => $client->revokeSession($token), IntegrationUnavailable::class, 'no false logout success');
    identityRejects(fn () => new UserApiIdentityGateway(new Factory(), '', ''), IntegrationUnavailable::class, 'missing service configuration fails closed');
    echo $count." identity assertions passed; all HTTP faked, no live accounts or secrets.\n";
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage()."\n");
    exit(1);
}
