<?php
use Illuminate\Support\Facades\Route;
use Stellar\DesktopApi\Http\Controllers\AuthController;
use Stellar\DesktopApi\Http\Controllers\ServerController;
use Stellar\DesktopApi\Http\Responses\Envelope;

// Mount with Laravel apiPrefix: 'api/v2'. No v1 routes, redirects or production fallback.
Route::get('/health', fn () => Envelope::success(['status' => 'ok', 'ready' => false, 'vpn_connected' => false]));
Route::get('/servers', ServerController::class);
Route::middleware('throttle:identity-credentials')->group(function () {
    Route::post('/auth/login', [AuthController::class, 'login']);
    Route::post('/auth/register', [AuthController::class, 'register']);
});
Route::middleware('throttle:identity-session')->group(function () {
    Route::post('/auth/session', [AuthController::class, 'inspect']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);
});
