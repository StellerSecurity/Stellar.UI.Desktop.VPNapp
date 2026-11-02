<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\IdentityGateway;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;

final class UnavailableIdentityGateway implements IdentityGateway
{
    public function issueSession(LoginCredentials $credentials): Session
    {
        throw new IntegrationUnavailable('Identity integration is not configured.');
    }

    public function revokeSession(#[\SensitiveParameter] string $accessToken): void
    {
        throw new IntegrationUnavailable('Identity integration is not configured.');
    }
}
