<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;
use Stellar\DesktopApi\Domain\Session;
interface AnonymousIdentityGateway
{
    public function issueAnonymousSession(#[\SensitiveParameter] string $accountNumber): Session;
}
