<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;

use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;

interface IdentityGateway
{
    public function issueSession(LoginCredentials $credentials): Session;
    public function revokeSession(#[\SensitiveParameter] string $accessToken): void;
}
