<?php

use App\Http\Controllers\V1\ActivationLicenseController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider and all of them will
| be assigned to the "api" middleware group. Make something great!
|
*/


// Redemption bodies contain codes. Keep these routes out of legacy request-body telemetry.
Route::prefix('v1')->middleware(['basicAuth', 'throttle:30,1'])->group(function () {
        Route::post('vpn-redemptions/claim', [\App\Http\Controllers\V1\VpnRedemptionController::class, 'claim']);
        Route::post('vpn-redemptions/receipt', [\App\Http\Controllers\V1\VpnRedemptionController::class, 'show']);
});
Route::prefix('v1')->group(function () {
    Route::prefix('activationlicensecontroller')->group(function () {
        Route::controller(ActivationLicenseController::class)->group(function () {
            Route::post('/create', 'create')->middleware('basicAuth');
            Route::post('/activate', 'activate');
            Route::post('/verify', 'verify');
            Route::get('/activate', 'activate');
        });
    });
})->middleware(\Mondago\ApplicationInsights\Middleware\TrackRequest::class);

