<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Stellar\DesktopApi\Application\ServerService;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Http\Responses\Envelope;

final readonly class ServerController
{
    public function __construct(private ServerService $servers) {}
    public function __invoke(Request $request): JsonResponse
    {
        $country = $request->query('country');
        if ($country !== null && !is_string($country)) return Envelope::error('validation_failed', 'Invalid country filter.', 422);
        try {
            $servers = $this->servers->list($country);
        } catch (\InvalidArgumentException) {
            return Envelope::error('validation_failed', 'country must be a two-letter uppercase country code.', 422);
        } catch (IntegrationUnavailable) {
            return Envelope::error('integration_unavailable', 'VPN locations are unavailable.', 503);
        }
        return Envelope::success(array_map(fn ($s) => [
            'id' => $s->id, 'name' => $s->name, 'country_code' => $s->countryCode,
            'coordinates' => ['latitude' => $s->latitude, 'longitude' => $s->longitude],
        ], $servers));
    }
}
