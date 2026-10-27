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
}
