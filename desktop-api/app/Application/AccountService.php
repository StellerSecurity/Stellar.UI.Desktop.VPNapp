<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\DeviceGateway;

final readonly class AccountService
{
    public function __construct(private AuthService $auth, private SubscriptionGateway $subscriptions, private DeviceGateway $devices) {}
    public function current(#[\SensitiveParameter] string $token): array
    {
        $session = $this->auth->inspect($token);
        try {
            $subscription = SessionSubscription::current($this->subscriptions, $session);
        } catch (IntegrationUnavailable) {
            return ['account_id' => $session->accountId, 'subscription_state' => 'unavailable', 'subscription' => null,
                'devices_state' => 'unavailable', 'devices' => null];
        }
        $devices = []; $devicesState = 'not_applicable';
        if ($subscription) {
            try { $devices = $this->devices->forSubscription($subscription->id); $devicesState = 'available'; }
            catch (IntegrationUnavailable) { $devices = null; $devicesState = 'unavailable'; }
        }
        return ['account_id' => $session->accountId, 'subscription_state' => $subscription ? 'available' : 'none',
            'subscription' => $subscription?->toArray(), 'devices_state' => $devicesState, 'devices' => $devices];
    }
}
