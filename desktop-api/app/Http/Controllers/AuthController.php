<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Stellar\DesktopApi\Application\AuthService;
use Stellar\DesktopApi\Application\VpnLoginService;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Domain\LoginCredentials;
use Stellar\DesktopApi\Http\Responses\Envelope;

final readonly class AuthController
{
    public function __construct(private AuthService $auth, private VpnLoginService $vpn) {}
    public function login(Request $request): JsonResponse
    {
        return $this->authenticate($request, false);
    }
    public function register(Request $request): JsonResponse
    {
        return $this->authenticate($request, true);
    }
    public function accountLogin(Request $request): JsonResponse
    {
        return $this->authenticate($request, false, true);
    }
    private function authenticate(Request $request, bool $register, bool $anonymous = false): JsonResponse
    {
        $username = $request->input('username'); $password = $request->input('password');
        $number = $request->input('account_number');
        if ($anonymous ? !is_string($number) || !preg_match('/^[0-9]{16}$/D', $number) : !is_string($username) || !is_string($password)) return Envelope::error('validation_failed', 'Invalid login input.', 422);
        try {
            if ($anonymous) $session = $this->auth->loginAccount($number);
            else {
                $credentials = new LoginCredentials($username, $password);
                $session = $register ? $this->auth->register($credentials) : $this->auth->login($credentials);
            }
            $vpn = [];
            if (config('desktop-api.vpn_login') === true) {
                try {
                    $issued = $this->vpn->provision($session);
                    $vpn = ['vpn_state' => $issued ? 'ready' : 'subscription_required', 'vpn_auth' => $issued?->forLoginResponse()];
                } catch (IntegrationUnavailable) {
                    // An upstream VPN outage must not turn a valid account login into bad credentials.
                    $vpn = ['vpn_state' => 'unavailable', 'vpn_auth' => null];
                }
            }
            return Envelope::success(['access_token' => $session->accessToken(), 'token_type' => 'Bearer',
                'expires_at' => $session->expiresAt->format(DATE_ATOM), 'account_id' => $session->accountId] + $vpn);
        } catch (\InvalidArgumentException) {
            return Envelope::error('validation_failed', 'Invalid login input.', 422);
        } catch (IdentityRejected $failure) {
            return $this->rejection($failure);
        } catch (IntegrationUnavailable) {
            error_log('stellar_identity_request_unavailable'.PHP_EOL, 3, storage_path('framework/identity-errors.log'));
            return Envelope::error('integration_unavailable', 'Authentication is not connected in this environment.', 503);
        }
    }

    public function inspect(Request $request): JsonResponse
    {
        $token = $request->bearerToken();
        if (!$token) return Envelope::error('unauthenticated', 'A valid bearer token is required.', 401);
        try {
            $session = $this->auth->inspect($token);
            // Session restoration never echoes the bearer token back to the caller.
            return Envelope::success(['account_id' => $session->accountId, 'expires_at' => $session->expiresAt->format(DATE_ATOM)]);
        } catch (IdentityRejected $failure) {
            return $this->rejection($failure);
        } catch (IntegrationUnavailable) {
            return Envelope::error('integration_unavailable', 'Authentication is not connected in this environment.', 503);
        }
    }

    private function rejection(IdentityRejected $failure): JsonResponse
    {
        $message = match ($failure->errorCode) {
            'invalid_credentials' => 'Email or password is incorrect.',
            'invalid_session' => 'Your session has expired. Please sign in again.',
            'registration_unavailable' => 'Unable to create this account. Try signing in instead.',
            'rate_limited' => 'Too many attempts. Please try again later.',
            default => 'Please check your input and try again.',
        };
        return Envelope::error($failure->errorCode, $message, $failure->httpStatus);
    }

    public function logout(Request $request): JsonResponse
    {
        $token = $request->bearerToken();
        if (!$token || strlen($token) > 8192) return Envelope::error('unauthenticated', 'A valid bearer token is required.', 401);
        try {
            $this->auth->logout($token);
            return Envelope::success(['revoked' => true]);
        } catch (IdentityRejected $failure) {
            return $this->rejection($failure);
        } catch (IntegrationUnavailable) {
            return Envelope::error('integration_unavailable', 'Session revocation is not connected in this environment.', 503);
        }
    }
}
