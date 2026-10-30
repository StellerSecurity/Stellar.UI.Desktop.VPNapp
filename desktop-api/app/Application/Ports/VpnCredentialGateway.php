<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;
use Stellar\DesktopApi\Domain\VpnCredentials;

interface VpnCredentialGateway
{
    /** Registers a fresh device and issues a fresh, non-recoverable password. No retries. */
    public function issueForLogin(string $accountId, string $subscriptionId): VpnCredentials;
}
