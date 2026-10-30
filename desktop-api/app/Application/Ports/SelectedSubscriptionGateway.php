<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;
use Stellar\DesktopApi\Domain\Subscription;
interface SelectedSubscriptionGateway
{
    public function forSelection(string $accountId, string $subscriptionHash): ?Subscription;
}
