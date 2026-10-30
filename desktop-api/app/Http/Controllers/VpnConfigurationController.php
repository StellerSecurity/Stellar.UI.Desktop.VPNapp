<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Stellar\DesktopApi\Application\AuthService;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Application\Ports\VpnConfigurationGateway;
use Stellar\DesktopApi\Http\Responses\Envelope;

final readonly class VpnConfigurationController
{
    public function __construct(private AuthService $auth, private SubscriptionGateway $subscriptions, private VpnConfigurationGateway $servers) {}
    public function __invoke(Request $request): JsonResponse
    {
        if (config('desktop-api.vpn_login') !== true) return Envelope::error('integration_unavailable', 'VPN is not connected in this environment.', 503);
        $token = $request->bearerToken();
        if (!$token) return Envelope::error('unauthenticated', 'Please sign in.', 401);
        $id = $request->input('server_id');
        if (!is_string($id) || !preg_match('/^[a-z0-9-]{1,64}$/D', $id)) return Envelope::error('validation_failed', 'Choose a valid location.', 422);
        try {
            $session = $this->auth->inspect($token);
            $sub = \Stellar\DesktopApi\Application\SessionSubscription::current($this->subscriptions, $session);
            if (!$sub || !in_array($sub->status, ['active', 'trial'], true)
                || ($sub->expiresAt !== null && $sub->expiresAt <= new \DateTimeImmutable('now'))) {
                return Envelope::error('subscription_required', 'An active VPN subscription is required.', 403);
            }
            return Envelope::success($this->servers->configuration($id));
        } catch (IdentityRejected) { return Envelope::error('invalid_session', 'Please sign in again.', 401); }
        catch (\InvalidArgumentException) { return Envelope::error('invalid_server', 'This location is unavailable.', 404); }
        catch (IntegrationUnavailable) { return Envelope::error('integration_unavailable', 'Couldn’t load the VPN configuration.', 503); }
    }
}
