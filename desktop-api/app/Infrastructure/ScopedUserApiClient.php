<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\PendingRequest;
use StellarSecurity\UserApiLaravel\UserApiClient;

/** Reuse the SDK's scoped operations with a pinned, streaming server transport. */
final class ScopedUserApiClient extends UserApiClient
{
    public function __construct(
        private readonly Factory $http,
        #[\SensitiveParameter] private readonly string $serviceUsername,
        #[\SensitiveParameter] private readonly string $servicePassword,
    ) {
        parent::__construct('https://stellaruserapiprod.azurewebsites.net/api/');
    }

    protected function sessionClient(): PendingRequest
    {
        // Explicit injected server credentials; never put service authentication in UI.
        return $this->http->withBasicAuth($this->serviceUsername, $this->servicePassword)
            ->acceptJson()->asJson()->withHeaders(['Cache-Control' => 'no-store'])
            ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                'connect_timeout' => 5, 'timeout' => 15, 'stream' => true]);
    }

    public function __debugInfo(): array { return ['serviceCredentials' => '[redacted]']; }
    public function androidUser(string $userId): \Illuminate\Http\Client\Response
    {
        return $this->sessionClient()->get('https://stellaruserapiprod.azurewebsites.net/api/v1/usercontroller/user/'.$userId);
    }
    /** Existing legacy API contract, server-to-server only. Never log URLs or retain HTTP exceptions. */
    public function androidToken(#[\SensitiveParameter] string $token): \Illuminate\Http\Client\Response
    {
        return $this->sessionClient()->get('https://stellaruserapiprod.azurewebsites.net/api/v1/personaltokencontroller/'.rawurlencode($token));
    }
}
