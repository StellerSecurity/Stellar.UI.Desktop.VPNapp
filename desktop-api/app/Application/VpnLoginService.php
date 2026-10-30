<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\VpnCredentialGateway;
use Stellar\DesktopApi\Domain\Session;
use Stellar\DesktopApi\Domain\VpnCredentials;

final readonly class VpnLoginService
{
    public function __construct(private SubscriptionGateway $subscriptions, private VpnCredentialGateway $credentials) {}
    public function provision(Session $verifiedSession): ?VpnCredentials
    {
        $subscription = SessionSubscription::current($this->subscriptions, $verifiedSession);
        if (!$subscription || !in_array($subscription->status, ['active', 'trial'], true)
            || ($subscription->expiresAt !== null && $subscription->expiresAt <= new \DateTimeImmutable('now'))) return null;
        return $this->credentials->issueForLogin($verifiedSession->accountId, $subscription->id);
    }
}
