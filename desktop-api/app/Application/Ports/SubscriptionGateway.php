<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;
use Stellar\DesktopApi\Domain\Subscription;

interface SubscriptionGateway
{
    public function forAccount(string $accountId): ?Subscription;
}
