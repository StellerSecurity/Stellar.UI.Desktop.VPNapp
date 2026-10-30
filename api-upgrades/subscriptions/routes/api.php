<?php

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


Route::prefix('v1')->group(function () {

    Route::middleware(['basicAuth'])->group(function () {
        Route::post('subscriptioncontroller/license-credit', [\App\Http\Controllers\v1\VpnLicenseCreditController::class, 'credit'])->middleware(\Illuminate\Routing\Middleware\ThrottleRequests::class.':30,1');
        Route::prefix('account-claims')->group(function () {
            Route::post('legacy-transfer', [\App\Http\Controllers\v1\ProvisionalAccountClaimController::class, 'legacyTransfer']);
            foreach (['ready','status','register','authorize','transfer'] as $action) {
                Route::post($action, [\App\Http\Controllers\v1\ProvisionalAccountClaimController::class, $action === 'authorize' ? 'authorizeClaim' : $action]);
            }
        });

        Route::post('factory-vpn/register', [\App\Http\Controllers\v1\FactoryVpnHandoverController::class, 'register']);
        Route::post('factory-vpn/activate', [\App\Http\Controllers\v1\FactoryVpnHandoverController::class, 'activate']);

        Route::get('subscriptioncontroller/entitlement/{id}', [\App\Http\Controllers\v1\PaymentCreditController::class, 'entitlement'])->where('id', '(?:[0-9]{16}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})');
        Route::post('subscriptioncontroller/credit', [\App\Http\Controllers\v1\PaymentCreditController::class, 'credit']);
        Route::get('subscriptioncontroller/credit-status', [\App\Http\Controllers\v1\PaymentCreditController::class, 'status']);

        // wipe user controller
        Route::prefix('subscriptioncontroller')->group(function () {
            Route::controller(\App\Http\Controllers\v1\SubscriptionController::class)->group(function () {
                Route::post('/add', 'add');
                Route::get('/find/{id}', 'find');
                Route::get('/user/subscriptions', 'findusersubscriptions');
                Route::get('/reseller/{reseller_user_id}', 'reseller');
                Route::patch('/patch', 'patch');
                Route::post('/activate/{id}', 'activate');
            });
        });


        Route::prefix('subscriptioneventcontroller')->group(function () {
            Route::controller(\App\Http\Controllers\v1\SubscriptionEventController::class)->group(function () {
                Route::post('/add', 'add');
                Route::get('/find/{id}', 'find');
                Route::get('/subscription/{subscription_id}', 'subscription');
                Route::get('/user/{user_id}', 'user');
            });
        });

        Route::prefix('plancontroller')->group(function () {
            Route::controller(\App\Http\Controllers\v1\PlanController::class)->group(function () {
                Route::get('/{plan_id}', 'plan');
            });
        });

    });

    Route::prefix('subscriptioncontroller')->group(function () {
        Route::controller(\App\Http\Controllers\v1\SubscriptionController::class)->group(function () {
            Route::get('scheduler', 'scheduler');
        });
    });

})->middleware(\App\Http\Middleware\SafeTrackRequest::class);

