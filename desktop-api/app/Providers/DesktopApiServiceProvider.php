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

final class DesktopApiServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        StagingPolicy::assertFixtureMode(
            (string) $this->app->environment(),
            (string) config('desktop-api.mode', 'disabled'),
            config('desktop-api.azure_site'),
        );
        $this->app->singleton(ServerCatalog::class, fn () => new FixtureServerCatalog(base_path('fixtures/servers.json')));
        $this->app->singleton(IdentityGateway::class, UnavailableIdentityGateway::class);
        $identity = config('desktop-api.identity', 'disabled');
        if (!in_array($identity, ['disabled', 'user-api'], true)) throw new \RuntimeException('Invalid identity mode.');
        if ($identity === 'user-api') {
            // Explicit staging opt-in only. No legacy API binding/configuration changes.
            $this->app->singleton(IdentityGateway::class, function ($app) {
                $username = (string) config('desktop-api.user_service_username', '');
                $password = (string) config('desktop-api.user_service_password', '');
                return new UserApiIdentityGateway($app->make(Factory::class), $username, $password);
            });
        }
    }
    public function boot(): void
    {
        RateLimiter::for('identity-credentials', fn ($request) => Limit::perMinute(10)->by($request->ip()));
        RateLimiter::for('identity-session', fn ($request) => Limit::perMinute(60)->by($request->ip()));
    }
}
