<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\ScopedIdentityGateway;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;

/** Server-side only. Not bound in fixture mode; activation needs server configuration. */
final class UserApiIdentityGateway implements ScopedIdentityGateway, \Stellar\DesktopApi\Application\Ports\AnonymousIdentityGateway
{
    private readonly ScopedUserApiClient $users;
    private readonly ?AndroidVpnSessionGateway $android;

    public function __construct(
        Factory $http,
        #[\SensitiveParameter] string $serviceUsername,
        #[\SensitiveParameter] string $servicePassword,
        private readonly ?AnonymousAccountGateway $anonymous = null,
        ?\Illuminate\Contracts\Cache\Repository $anonymousSessions = null,
    ) {
        if ($serviceUsername === '' || $servicePassword === '' || str_contains($serviceUsername, ':')
            || preg_match('/[\x00-\x1f\x7f]/', $serviceUsername.$servicePassword)) {
            throw new IntegrationUnavailable('Identity integration is not configured.');
        }
        $this->users = new ScopedUserApiClient($http, $serviceUsername, $servicePassword);
        $this->android = $anonymousSessions ? new AndroidVpnSessionGateway($this->users, $anonymousSessions) : null;
    }

    public function issueSession(LoginCredentials $credentials): Session
    {
        return $this->session($this->request('login', ['username' => $credentials->username, 'password' => $credentials->password()]));
    }

    public function issueAnonymousSession(#[\SensitiveParameter] string $accountNumber): Session
    {
        if (!$this->anonymous || !$this->android) throw new IntegrationUnavailable();
        $owner = $this->anonymous->owner($accountNumber);
        return $this->android->issue($owner, hash('sha256', $accountNumber));
    }

    public function registerSession(LoginCredentials $credentials): Session
    {
        if (strlen($credentials->password()) < 6) throw new IdentityRejected('invalid_input', 422);
        return $this->session($this->request('register', ['username' => $credentials->username, 'password' => $credentials->password()]));
    }

    public function inspectSession(#[\SensitiveParameter] string $token): Session
    {
        $this->validateToken($token);
        if ($this->android?->handles($token)) return $this->android->inspect($token);
        return $this->session($this->request('introspect', ['token' => $token]), $token);
    }

    public function revokeSession(#[\SensitiveParameter] string $accessToken): void
    {
        $this->validateToken($accessToken);
        if ($this->android?->handles($accessToken)) { $this->android->revoke($accessToken); return; }
        if (($this->request('logout', ['token' => $accessToken])['revoked'] ?? null) !== true) {
            throw new IntegrationUnavailable('Identity response was invalid.');
        }
    }

    private function validateToken(#[\SensitiveParameter] string $token): void
    {
        if (strlen($token) > 256 || !preg_match('/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/D', $token)) {
            throw new IdentityRejected('invalid_session', 401);
        }
    }

    private function session(#[\SensitiveParameter] array $data, #[\SensitiveParameter] ?string $knownToken = null): Session
    {
        $token = $knownToken ?? ($data['token'] ?? null);
        $id = $data['user']['id'] ?? null;
        $expiry = $data['expires_at'] ?? null;
        if (!is_string($token) || !is_string($id) || !preg_match('/^[1-9][0-9]*$/D', $id)
            || !is_string($expiry) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/D', $expiry)
            || ($knownToken === null && ($data['token_type'] ?? null) !== 'Bearer')) {
            throw new IntegrationUnavailable('Identity response was invalid.');
        }
        try {
            $this->validateToken($token);
            $expiresAt = new \DateTimeImmutable($expiry);
            $dateErrors = \DateTimeImmutable::getLastErrors();
            if ($dateErrors !== false && ($dateErrors['warning_count'] > 0 || $dateErrors['error_count'] > 0)) throw new \RuntimeException();
            if ($expiresAt <= new \DateTimeImmutable('now')) throw new \RuntimeException();
        } catch (\Throwable) {
            throw new IntegrationUnavailable('Identity response was invalid.');
        }
        return new Session($token, $id, $expiresAt);
    }

    private function request(string $operation, #[\SensitiveParameter] array $body): array
    {
        // No arbitrary URL, redirects, retries, expiry override or browser-facing service secret.
        if (!in_array($operation, ['login', 'register', 'introspect', 'logout'], true)) {
            throw new IntegrationUnavailable('Identity operation is unavailable.');
        }
        try {
            $response = match ($operation) {
                'login' => $this->users->loginSession($body['username'], $body['password']),
                'register' => $this->users->registerSession($body['username'], $body['password']),
                'introspect' => $this->users->introspectSession($body['token']),
                'logout' => $this->users->logoutSession($body['token']),
            };
            $stream = $response->toPsrResponse()->getBody();
            try {
                $raw = '';
                while (!$stream->eof() && strlen($raw) <= 65536) {
                    $part = $stream->read(65537 - strlen($raw));
                    if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                    $raw .= $part;
                }
            } finally { $stream->close(); }
            $status = $response->status();
            $contentType = strtolower(explode(';', $response->header('Content-Type'))[0]);
            $challenge = $response->header('WWW-Authenticate');
        } catch (\Throwable $failure) {
            // Do not chain an HTTP exception that may retain Authorization/password/token.
            error_log('stellar_identity_transport_failed: '.get_class($failure).PHP_EOL, 3, storage_path('framework/identity-errors.log'));
            throw new IntegrationUnavailable('Identity service is unavailable.');
        }
        // A Basic challenge is a server integration failure, not a wrong user password.
        if ($status === 401 && ($contentType !== 'application/json' || preg_match('/^Basic\b/i', $challenge))) {
            error_log('stellar_identity_service_auth_rejected'.PHP_EOL, 3, storage_path('framework/identity-errors.log'));
            throw new IntegrationUnavailable('Identity service is unavailable.');
        }
        if (in_array($status, [401, 409, 422, 429], true)) {
            $code = match ($status) { 401 => $operation === 'login' ? 'invalid_credentials' : 'invalid_session',
                409 => 'registration_unavailable', 422 => 'invalid_input', 429 => 'rate_limited' };
            throw new IdentityRejected($code, $status);
        }
        if ($status !== 200 || strlen($raw) > 65536 || $contentType !== 'application/json') {
            error_log('stellar_identity_unexpected_http_status: '.$status.PHP_EOL, 3, storage_path('framework/identity-errors.log'));
            throw new IntegrationUnavailable('Identity service is unavailable.');
        }
        try { $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { throw new IntegrationUnavailable('Identity response was invalid.'); }
        if (!is_array($data) || ($data['response_code'] ?? null) !== 200) {
            throw new IntegrationUnavailable('Identity response was invalid.');
        }
        return $data;
    }

    public function __debugInfo(): array { return ['serviceCredentials' => '[redacted]']; }
}
