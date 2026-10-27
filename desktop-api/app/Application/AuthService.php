<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;

use Stellar\DesktopApi\Application\Ports\IdentityGateway;
use Stellar\DesktopApi\Application\Ports\ScopedIdentityGateway;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;

final readonly class AuthService
{
    public function __construct(private IdentityGateway $identity) {}
    public function login(LoginCredentials $credentials): Session { return $this->identity->issueSession($credentials); }
    public function register(LoginCredentials $credentials): Session
    {
        if (!filter_var($credentials->username, FILTER_VALIDATE_EMAIL) || strlen($credentials->password()) < 12) {
            throw new \InvalidArgumentException('Invalid registration input.');
        }
        return $this->scoped()->registerSession($credentials);
    }
    public function inspect(#[\SensitiveParameter] string $token): Session
    {
        $this->validateToken($token);
        return $this->scoped()->inspectSession($token);
    }
    private function scoped(): ScopedIdentityGateway
    {
        if (!$this->identity instanceof ScopedIdentityGateway) throw new IntegrationUnavailable('Identity integration is not configured.');
        return $this->identity;
    }
    private function validateToken(#[\SensitiveParameter] string $token): void
    {
        if (strlen($token) > 256 || preg_match('/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/D', $token) !== 1) {
            throw new IdentityRejected('invalid_session', 401);
        }
    }
    public function logout(#[\SensitiveParameter] string $token): void
    {
        $this->validateToken($token);
        $this->identity->revokeSession($token);
    }
}
