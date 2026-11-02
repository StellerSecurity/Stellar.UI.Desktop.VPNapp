<?php
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Stellar\DesktopApi\Http\Responses\Envelope;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: 'api/v2')
    ->withMiddleware()
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->render(function (\Throwable $error) {
            // Laravel's rate limiter carries its pre-execution JSON response
            // in this exception. Preserve status, Retry-After and safe marker.
            if ($error instanceof \Illuminate\Http\Exceptions\HttpResponseException) return $error->getResponse();
            if ($error instanceof \Stellar\DesktopApi\Application\IntegrationUnavailable) {
                error_log('stellar_identity_configuration_unavailable'.PHP_EOL, 3, storage_path('framework/identity-errors.log'));
                return Envelope::error('integration_unavailable', 'Authentication is not connected in this environment.', 503);
            }
            // This is a dedicated API: unknown paths must also return JSON, not a view.
            $status = $error instanceof HttpExceptionInterface ? $error->getStatusCode() : 500;
            $code = match ($status) { 404 => 'not_found', 405 => 'method_not_allowed', 429 => 'rate_limited', default => 'request_failed' };
            // Never send exception text, upstream bodies, tokens or traces to clients.
            return Envelope::error($code, 'The request could not be completed.', $status);
        });
    })->create();
