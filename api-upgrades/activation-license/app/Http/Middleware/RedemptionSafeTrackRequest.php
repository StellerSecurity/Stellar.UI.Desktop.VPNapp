<?php
namespace App\Http\Middleware;
use Illuminate\Http\Request;
use Mondago\ApplicationInsights\Middleware\TrackRequest;

/** Preserve legacy telemetry exactly; only new receipt endpoints get a sanitized request. */
class RedemptionSafeTrackRequest extends TrackRequest
{
    public function terminate($request, $response)
    {
        if ($request->is('api/v1/vpn-redemptions/*')) {
            // Keep method, timing and status monitoring, never caller query/headers/IP.
            $request = Request::create('https://activation.invalid/vpn-redemption', $request->method());
        }
        parent::terminate($request, $response);
    }
}
