<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;

use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Domain\Session;

interface ScopedIdentityGateway extends IdentityGateway
{
    public function registerSession(LoginCredentials $credentials): Session;
    public function inspectSession(#[\SensitiveParameter] string $token): Session;
}
