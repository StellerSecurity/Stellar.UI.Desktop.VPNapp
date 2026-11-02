<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Stellar\DesktopApi\Application\AccountService;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Http\Responses\Envelope;

final readonly class AccountController
{
    public function __construct(private AccountService $accounts) {}
    public function __invoke(Request $request): JsonResponse
    {
        $token = $request->bearerToken();
        if (!$token) return Envelope::error('unauthenticated', 'A valid bearer token is required.', 401);
        try { return Envelope::success($this->accounts->current($token)); }
        catch (IdentityRejected $failure) {
            return Envelope::error($failure->errorCode, 'Your session could not be verified. Please sign in again.', $failure->httpStatus);
        } catch (IntegrationUnavailable) {
            return Envelope::error('integration_unavailable', 'Your account is temporarily unavailable.', 503);
        }
    }
}
