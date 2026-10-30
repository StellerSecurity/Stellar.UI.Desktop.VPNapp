<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\SelectedSubscriptionGateway;
use Stellar\DesktopApi\Domain\Session;
use Stellar\DesktopApi\Domain\Subscription;
final class SessionSubscription
{
    public static function current(SubscriptionGateway $subscriptions, Session $session): ?Subscription
    {
        if ($session->subscriptionHash === null) return $subscriptions->forAccount($session->accountId);
        if (!$subscriptions instanceof SelectedSubscriptionGateway) throw new IntegrationUnavailable();
        return $subscriptions->forSelection($session->accountId, $session->subscriptionHash);
    }
}
