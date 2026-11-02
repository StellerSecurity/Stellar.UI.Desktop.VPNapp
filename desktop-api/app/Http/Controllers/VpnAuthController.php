<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Stellar\DesktopApi\Application\AuthService;
use Stellar\DesktopApi\Application\VpnLoginService;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Http\Responses\Envelope;

/** Issue missing device credentials after activation, without requesting the account password again. */
final readonly class VpnAuthController
{
    public function __construct(private AuthService $auth, private VpnLoginService $vpn) {}
    public function __invoke(Request $request): JsonResponse
    {
        if (config('desktop-api.vpn_login') !== true) return Envelope::error('integration_unavailable', 'VPN is not connected in this environment.', 503);
        $token = $request->bearerToken();
        if (!$token) return Envelope::error('unauthenticated', 'Please sign in.', 401);
        try {
            // Account and subscription ownership come exclusively from the verified session.
            $issued = $this->vpn->provision($this->auth->inspect($token));
            if (!$issued) return Envelope::error('subscription_required', 'An active VPN subscription is required.', 403);
            return Envelope::success(['vpn_state' => 'ready', 'vpn_auth' => $issued->forLoginResponse()]);
        } catch (IdentityRejected) { return Envelope::error('invalid_session', 'Please sign in again.', 401); }
        catch (IntegrationUnavailable) { return Envelope::error('integration_unavailable', 'VPN setup is temporarily unavailable. Please try again.', 503); }
    }
}
