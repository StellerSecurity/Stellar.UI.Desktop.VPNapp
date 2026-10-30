<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;
use Illuminate\Http\Request;
use Stellar\DesktopApi\Application\AuthService;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\ActivationRejected;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Infrastructure\ActivationApiGateway;
use Stellar\DesktopApi\Http\Responses\Envelope;

final readonly class ActivationController
{
    public function __construct(private AuthService $auth, private SubscriptionGateway $subscriptions, private ActivationApiGateway $activation) {}
    public function __invoke(Request $request) {
        $token = $request->bearerToken();
        if (!$token) return Envelope::error('unauthenticated', 'A valid bearer token is required.', 401);
        // IDs and duration are resolved by verified server-side ownership, not client input.
        $code = $request->input('activation_code');
        if (!is_string($code) || !preg_match('/\A[A-Za-z0-9-]{4,128}\z/', $code)) return Envelope::error('invalid_activation_code', 'Enter a valid activation code.', 422);
        if (config('desktop-api.activation_enabled') !== true) return Envelope::error('activation_unavailable', 'Activation is temporarily unavailable.', 503);
        try {
            $session = $this->auth->inspect($token);
            $subscription = \Stellar\DesktopApi\Application\SessionSubscription::current($this->subscriptions, $session);
            if (!$subscription) return Envelope::error('subscription_required', 'No VPN subscription was found for this account.', 409);
            $this->activation->redeem($code, $session->accountId, $subscription->id);
            return Envelope::success(['activated' => true]);
        } catch (IdentityRejected $failure) {
            return Envelope::error($failure->errorCode, 'Please sign in again.', $failure->httpStatus);
        } catch (ActivationRejected) { return Envelope::error('invalid_activation_code', 'This code is invalid, already used, or belongs to another subscription.', 409); }
        catch (IntegrationUnavailable) { return Envelope::error('activation_unavailable', 'Activation could not be confirmed. Retry the same code to resume safely.', 503); }
    }
}
