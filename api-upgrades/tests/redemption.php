<?php
declare(strict_types=1);
// Offline harness uses the already-reviewed desktop Laravel runtime, SQLite memory and HTTP fakes.
if (getenv('APP_ENV') !== 'testing' || getenv('STELLAR_API_MODE') !== 'fixture') exit(1);
require dirname(__DIR__, 2).'/desktop-api/vendor/autoload.php';
require __DIR__.'/Controller.php';
require dirname(__DIR__).'/activation-license/app/Status.php';
require dirname(__DIR__).'/activation-license/app/Type.php';
require dirname(__DIR__).'/activation-license/app/Models/ActivationLicense.php';
require dirname(__DIR__).'/activation-license/app/Http/Controllers/V1/ActivationLicenseController.php';
require dirname(__DIR__).'/subscriptions/app/Models/Subscription.php';
require dirname(__DIR__).'/activation-license/app/Http/Controllers/V1/VpnRedemptionController.php';
require dirname(__DIR__).'/subscriptions/app/Http/Controllers/v1/VpnLicenseCreditController.php';
$app = require dirname(__DIR__, 2).'/desktop-api/bootstrap/app.php';
$app->instance('request', Illuminate\Http\Request::create('http://127.0.0.1/'));
$app->make(Illuminate\Contracts\Http\Kernel::class)->bootstrap();
$app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('T', 32)));
$app['config']->set(['database.default' => 'sqlite', 'database.connections.sqlite' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => ''],
    'vpn-redemption.username' => 'synthetic', 'vpn-redemption.password' => 'synthetic']);
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
Schema::create('activationlicenses', function (Blueprint $t) { $t->increments('id'); $t->string('code')->unique(); $t->integer('type'); $t->integer('status'); $t->integer('subscriptions_days'); $t->timestamps(); });
Schema::create('subscriptions', function (Blueprint $t) { $t->string('id')->primary(); $t->integer('user_id'); $t->integer('type'); $t->integer('status'); $t->dateTime('expires_at')->nullable(); $t->dateTime('activated_at')->nullable(); $t->text('meta')->nullable(); $t->timestamps(); $t->softDeletes(); });
(require dirname(__DIR__).'/activation-license/database/migrations/2026_10_29_120000_create_vpn_license_redemptions.php')->up();
(require dirname(__DIR__).'/subscriptions/database/migrations/2026_10_29_120000_create_vpn_license_credits.php')->up();
$checks = 0;
function checkRedemption(bool $value, string $name): void { global $checks; if (!$value) throw new RuntimeException($name); $checks++; }
function req(array $data): Illuminate\Http\Request { return Illuminate\Http\Request::create('/', 'POST', $data); }
$claims = new App\Http\Controllers\V1\VpnRedemptionController();
$credits = new App\Http\Controllers\v1\VpnLicenseCreditController();
$http = $app->make(Illuminate\Http\Client\Factory::class); $http->preventStrayRequests();
$outage = false; $forged = false;
$http->fake(function ($r) use ($http, $claims, &$outage, &$forged) {
    checkRedemption($r->url() === 'https://stellaractivationlicenseapiprod.azurewebsites.net/api/v1/vpn-redemptions/receipt' && $r->method() === 'POST', 'fixed receipt-only lookup');
    if ($outage) return $http->response([], 503, ['Content-Type' => 'application/json']);
    $response = $claims->show(req($r->data())); $data = $response->getData(true);
    if ($forged) $data['account_id'] = '99';
    return $http->response($data, $response->status(), ['Content-Type' => 'application/json']);
});
try {
    Carbon\Carbon::setTestNow('2026-10-29 12:00:00 UTC');
    DB::table('activationlicenses')->insert(['code' => 'TEST-CODE', 'type' => 1, 'status' => 1, 'subscriptions_days' => 30]);
    DB::table('subscriptions')->insert(['id' => 'sub-42', 'user_id' => 42, 'type' => 1, 'status' => 0, 'expires_at' => '2020-01-01 00:00:00']);
    $input = ['code' => 'TEST-CODE', 'account_id' => '42', 'subscription_id' => 'sub-42'];
    $receipt = $claims->claim(req($input))->getData(true);
    checkRedemption($receipt['days'] === 30 && DB::table('activationlicenses')->value('status') === 2, 'claim consumes only alongside durable receipt');
    $replay = $claims->claim(req($input))->getData(true);
    checkRedemption($replay === $receipt && DB::table('vpn_license_redemptions')->count() === 1, 'lost claim response resumes same receipt');
    checkRedemption($claims->claim(req([...$input, 'account_id' => '99']))->status() === 409, 'foreign account cannot replay');
    checkRedemption($claims->claim(req([...$input, 'subscription_id' => 'other']))->status() === 409, 'foreign subscription cannot replay');
    $credit = ['receipt_id' => $receipt['receipt_id'], 'account_id' => '42', 'subscription_id' => 'sub-42', 'days' => 99999];
    $outage = true;
    checkRedemption($credits->credit(req($credit))->status() === 503 && DB::table('vpn_license_credits')->count() === 0, 'receipt outage cannot alter subscription');
    $outage = false; $forged = true;
    checkRedemption($credits->credit(req($credit))->status() === 409, 'receipt owner mismatch fails closed');
    $forged = false;
    checkRedemption($credits->credit(req($credit))->getData(true)['credited'] === true, 'resume after outage credits');
    $expiry = DB::table('subscriptions')->value('expires_at');
    checkRedemption($expiry === '2026-11-28 12:00:00', 'expired plan adds signed server duration from now, ignores caller days');
    checkRedemption($credits->credit(req($credit))->getData(true)['replayed'] === true, 'lost credit response safely replays');
    checkRedemption(DB::table('subscriptions')->value('expires_at') === $expiry && DB::table('vpn_license_credits')->count() === 1, 'replay never grants twice');
    // Transaction failure between plan save and ledger insert must roll back BOTH.
    DB::table('activationlicenses')->insert(['code' => 'SECOND-CODE', 'type' => 1, 'status' => 1, 'subscriptions_days' => 7]);
    $second = $claims->claim(req([...$input, 'code' => 'SECOND-CODE']))->getData(true);
    DB::statement("CREATE TRIGGER fail_credit BEFORE INSERT ON vpn_license_credits BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    try { $credits->credit(req([...$credit, 'receipt_id' => $second['receipt_id']])); throw new RuntimeException('expected rollback'); }
    catch (Illuminate\Database\QueryException) {}
    checkRedemption(DB::table('subscriptions')->value('expires_at') === $expiry, 'database failure rolls back subscription extension');
    DB::statement('DROP TRIGGER fail_credit');
    $credits->credit(req([...$credit, 'receipt_id' => $second['receipt_id']]));
    checkRedemption(DB::table('subscriptions')->value('expires_at') === '2026-12-05 12:00:00', 'durable receipt recovers after transaction rollback');
    checkRedemption(DB::table('vpn_license_redemptions')->count() === 2 && DB::table('vpn_license_credits')->count() === 2, 'one receipt and one credit per code');
    $legacy = new App\Http\Controllers\V1\ActivationLicenseController();
    checkRedemption($legacy->activate(req(['code' => 'TEST-CODE', 'type' => 1, 'activate' => 1]))->getData(true)['response_code'] === 400, 'legacy route cannot consume a claimed code');
    DB::table('activationlicenses')->insert(['code' => 'LEGACY-CODE', 'type' => 1, 'status' => 1, 'subscriptions_days' => 7]);
    checkRedemption($legacy->activate(req(['code' => 'LEGACY-CODE', 'type' => 1, 'activate' => 1]))->getData(true)['response_code'] === 200, 'legacy contract retained');
    checkRedemption($claims->claim(req([...$input, 'code' => 'LEGACY-CODE']))->status() === 409, 'new route cannot consume a legacy-consumed code');
    DB::table('activationlicenses')->insert(['code' => 'ROLLBACK-CODE', 'type' => 1, 'status' => 1, 'subscriptions_days' => 7]);
    DB::statement("CREATE TRIGGER fail_claim BEFORE UPDATE ON activationlicenses BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    try { $claims->claim(req([...$input, 'code' => 'ROLLBACK-CODE'])); throw new RuntimeException('expected claim rollback'); }
    catch (Illuminate\Database\QueryException) {}
    DB::statement('DROP TRIGGER fail_claim');
    checkRedemption(DB::table('vpn_license_redemptions')->count() === 2 && DB::table('activationlicenses')->where('code', 'ROLLBACK-CODE')->value('status') === 1, 'claim failure rolls back both receipt and consumption');
    DB::table('activationlicenses')->insert(['code' => 'PENDING-CODE', 'type' => 1, 'status' => 1, 'subscriptions_days' => 7]);
    DB::table('subscriptions')->insert(['id' => 'pending-42', 'user_id' => 42, 'type' => 1, 'status' => 0, 'meta' => json_encode(['activate_on_login' => true, 'activated' => false, 'activation_days' => 30])]);
    $pending = $claims->claim(req([...$input, 'code' => 'PENDING-CODE', 'subscription_id' => 'pending-42']))->getData(true);
    $credits->credit(req([...$credit, 'receipt_id' => $pending['receipt_id'], 'subscription_id' => 'pending-42']));
    checkRedemption(DB::table('subscriptions')->where('id', 'pending-42')->value('expires_at') === '2026-12-05 12:00:00', 'pending plan retains its purchased days plus redeemed days');
    foreach ([['code' => 'WRONG-PRODUCT', 'type' => 0, 'status' => 1, 'subscriptions_days' => 30],
        ['code' => 'INACTIVE-CODE', 'type' => 1, 'status' => 0, 'subscriptions_days' => 30],
        ['code' => 'INVALID-DAYS', 'type' => 1, 'status' => 1, 'subscriptions_days' => 0]] as $invalid) {
        DB::table('activationlicenses')->insert($invalid);
        checkRedemption($claims->claim(req([...$input, 'code' => $invalid['code']]))->status() === 409, 'wrong product, inactive or invalid duration rejected');
        checkRedemption(DB::table('activationlicenses')->where('code', $invalid['code'])->value('status') === $invalid['status'], 'invalid license never consumed');
    }
    echo "$checks redemption assertions passed; SQLite memory database, all HTTP faked.\n";
} catch (Throwable $error) { fwrite(STDERR, get_class($error).': '.$error->getMessage()."\n"); exit(1); }
finally { Carbon\Carbon::setTestNow(); }
