<?php
use Illuminate\Support\Facades\Route;
use Stellar\DesktopApi\Http\Controllers\AuthController;
use Stellar\DesktopApi\Http\Controllers\AccountController;
use Stellar\DesktopApi\Http\Controllers\ServerController;
use Stellar\DesktopApi\Http\Responses\Envelope;

// Mount with Laravel apiPrefix: 'api/v2'. No v1 routes, redirects or production fallback.
Route::get('/health', fn () => Envelope::success(['status' => 'ok', 'ready' => false, 'vpn_connected' => false]));
Route::get('/servers', ServerController::class);
Route::post('/account/activation', \Stellar\DesktopApi\Http\Controllers\ActivationController::class)->middleware('throttle:activation');
Route::middleware('throttle:identity-credentials')->group(function () {
    Route::post('/auth/login', [AuthController::class, 'login']);
    Route::post('/auth/account-login', [AuthController::class, 'accountLogin']);
    Route::post('/auth/register', [AuthController::class, 'register']);
});
Route::middleware('throttle:identity-session')->group(function () {
    Route::post('/vpn/auth', \Stellar\DesktopApi\Http\Controllers\VpnAuthController::class);
    Route::post('/vpn/configuration', \Stellar\DesktopApi\Http\Controllers\VpnConfigurationController::class);
    Route::post('/account', AccountController::class);
    Route::post('/auth/session', [AuthController::class, 'inspect']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);
});
