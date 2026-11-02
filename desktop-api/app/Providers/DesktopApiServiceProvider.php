<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Providers;

use Illuminate\Support\ServiceProvider;
use Stellar\DesktopApi\Application\Ports\IdentityGateway;
use Stellar\DesktopApi\Application\Ports\ServerCatalog;
use Stellar\DesktopApi\Infrastructure\FixtureServerCatalog;
use Stellar\DesktopApi\Infrastructure\StagingPolicy;
use Stellar\DesktopApi\Infrastructure\UnavailableIdentityGateway;
use Stellar\DesktopApi\Infrastructure\UserApiIdentityGateway;
use Illuminate\Http\Client\Factory;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Support\Facades\RateLimiter;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Infrastructure\SubscriptionApiGateway;
use Stellar\DesktopApi\Application\Ports\DeviceGateway;
use Stellar\DesktopApi\Infrastructure\DeviceApiGateway;
use Stellar\DesktopApi\Application\Ports\VpnCredentialGateway;
use Stellar\DesktopApi\Infrastructure\VpnCredentialApiGateway;
use Stellar\DesktopApi\Infrastructure\VpnServerApiCatalog;
use Stellar\DesktopApi\Application\Ports\VpnConfigurationGateway;

final class DesktopApiServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(\Stellar\DesktopApi\Infrastructure\ActivationApiGateway::class, fn ($app) => new \Stellar\DesktopApi\Infrastructure\ActivationApiGateway($app->make(Factory::class),
            (string) config('desktop-api.activation_service_username', ''), (string) config('desktop-api.activation_service_password', ''),
            (string) config('desktop-api.subscription_service_username', ''), (string) config('desktop-api.subscription_service_password', '')));
        StagingPolicy::assertFixtureMode(
            (string) $this->app->environment(),
            (string) config('desktop-api.mode', 'disabled'),
            config('desktop-api.azure_site'),
        );
        $this->app->singleton(ServerCatalog::class, fn () => new FixtureServerCatalog(base_path('fixtures/servers.json')));
        $this->app->singleton(VpnServerApiCatalog::class, fn ($app) => new VpnServerApiCatalog($app->make(Factory::class),
            (string) config('desktop-api.vpn_service_username', ''), (string) config('desktop-api.vpn_service_password', '')));
        $this->app->singleton(VpnConfigurationGateway::class, fn ($app) => $app->make(VpnServerApiCatalog::class));
        if (config('desktop-api.vpn_login') === true) {
            $this->app->singleton(ServerCatalog::class, fn ($app) => $app->make(VpnServerApiCatalog::class));
        }
        $this->app->singleton(IdentityGateway::class, UnavailableIdentityGateway::class);
        $this->app->singleton(VpnCredentialGateway::class, fn ($app) => new VpnCredentialApiGateway($app->make(Factory::class),
            (string) config('desktop-api.device_service_username', ''), (string) config('desktop-api.device_service_password', ''),
            (string) config('desktop-api.vpn_service_username', ''), (string) config('desktop-api.vpn_service_password', '')));
        $this->app->singleton(SubscriptionGateway::class, fn ($app) => new SubscriptionApiGateway($app->make(Factory::class),
            (string) config('desktop-api.subscription_service_username', ''), (string) config('desktop-api.subscription_service_password', '')));
        $this->app->singleton(DeviceGateway::class, fn ($app) => new DeviceApiGateway($app->make(Factory::class),
            (string) config('desktop-api.device_service_username', ''), (string) config('desktop-api.device_service_password', '')));
        $identity = config('desktop-api.identity', 'disabled');
        if (!in_array($identity, ['disabled', 'user-api'], true)) throw new \RuntimeException('Invalid identity mode.');
        if ($identity === 'user-api') {
            // Explicit staging opt-in only. No legacy API binding/configuration changes.
            $this->app->singleton(IdentityGateway::class, function ($app) {
                $username = (string) config('desktop-api.user_service_username', '');
                $password = (string) config('desktop-api.user_service_password', '');
                return new UserApiIdentityGateway($app->make(Factory::class), $username, $password,
                    new \Stellar\DesktopApi\Infrastructure\AnonymousAccountGateway($app->make(Factory::class),
                        (string) config('desktop-api.subscription_service_username', ''), (string) config('desktop-api.subscription_service_password', '')),
                    $app->make('cache.store'));
            });
        }
    }
    public function boot(): void
    {
        // This marker is emitted only by middleware before the controller runs.
        // Never mark ambiguous upstream errors as safe to replay.
        $rejected = fn ($request, array $headers) => \Stellar\DesktopApi\Http\Responses\Envelope::error('rate_limited', 'Too many attempts. Please try again later.', 429)
            ->withHeaders($headers + ['X-Stellar-Retry-Safe' => 'not-executed']);
        RateLimiter::for('identity-credentials', fn ($request) => Limit::perMinute(10)->by($request->ip())->response($rejected));
        RateLimiter::for('activation', fn ($request) => Limit::perMinute(5)->by($request->ip())->response($rejected));
        RateLimiter::for('identity-session', fn ($request) => Limit::perMinute(60)->by($request->ip())->response($rejected));
    }
}
