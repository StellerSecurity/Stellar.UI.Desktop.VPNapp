<?php
namespace App\Http\Controllers\v1;
use App\Http\Controllers\Controller;
use App\Models\Subscription;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/** Internal basicAuth only; durable receipt determines owner, product and duration. */
class VpnLicenseCreditController extends Controller
{
    public function credit(Request $request) {
        $data = $request->validate([
            'receipt_id' => ['required', 'uuid'],
            'account_id' => ['required', 'string', 'max:32', 'regex:/\A[1-9][0-9]*\z/'],
            'subscription_id' => ['required', 'string', 'max:128', 'regex:/\A[A-Za-z0-9-]+\z/'],
        ]);
        $username = config('vpn-redemption.username'); $password = config('vpn-redemption.password');
        if (!is_string($username) || !is_string($password) || !$username || !$password || str_contains($username, ':')
            || preg_match('/[\x00-\x1f\x7f]/', $username.$password)) return $this->unavailable();
        try {
            $response = Http::withBasicAuth($username, $password)->acceptJson()
                ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true, 'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])
                ->post('https://stellaractivationlicenseapiprod.azurewebsites.net/api/v1/vpn-redemptions/receipt', ['receipt_id' => $data['receipt_id']]);
            $stream = $response->toPsrResponse()->getBody();
            try {
                $raw = '';
                while (!$stream->eof() && strlen($raw) <= 8192) {
                    $part = $stream->read(8193 - strlen($raw));
                    if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                    $raw .= $part;
                }
                if (strlen($raw) > 8192) throw new \RuntimeException();
            }
            finally { $stream->close(); }
            if ($response->status() !== 200 || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') return $this->unavailable();
            $receipt = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
        } catch (\Throwable) { return $this->unavailable(); }
        if (!is_array($receipt) || ($receipt['receipt_id'] ?? null) !== $data['receipt_id']
            || ($receipt['account_id'] ?? null) !== $data['account_id'] || ($receipt['subscription_id'] ?? null) !== $data['subscription_id']
            || ($receipt['type'] ?? null) !== 1 || !is_int($receipt['days'] ?? null) || $receipt['days'] < 1 || $receipt['days'] > 36500) {
            return response()->json(['error' => 'invalid_receipt'], 409, ['Cache-Control' => 'no-store']);
        }
        return DB::transaction(function () use ($data, $receipt) {
            $subscription = Subscription::where('id', $data['subscription_id'])->lockForUpdate()->first();
            if (!$subscription || (string) $subscription->user_id !== $data['account_id'] || (int) $subscription->type !== 1) {
                return response()->json(['error' => 'subscription_not_found'], 409, ['Cache-Control' => 'no-store']);
            }
            $existing = DB::table('vpn_license_credits')->where('receipt_id', $data['receipt_id'])->first();
            if ($existing) {
                if ($existing->account_id !== $data['account_id'] || $existing->subscription_id !== $data['subscription_id']) abort(409);
                return $this->success($data['receipt_id'], true);
            }
            $now = Carbon::now('UTC');
            $meta = is_array($subscription->meta) ? $subscription->meta : [];
            $expiry = $subscription->expires_at ? Carbon::parse($subscription->expires_at)->utc() : $now->copy();
            if (($meta['activate_on_login'] ?? null) === true && ($meta['activated'] ?? null) === false) {
                $pending = $meta['activation_days'] ?? null;
                if (!is_int($pending) || $pending < 1 || $pending > 36500) return $this->unavailable();
                $expiry = $now->copy()->addDays($pending);
                $meta['activated'] = true;
                $subscription->meta = $meta;
                $subscription->activated_at = $now;
            }
            if ($expiry->lt($now)) $expiry = $now->copy();
            $subscription->expires_at = $expiry->addDays($receipt['days']);
            $subscription->status = 1;
            $subscription->save();
            DB::table('vpn_license_credits')->insert(['receipt_id' => $data['receipt_id'], 'account_id' => $data['account_id'],
                'subscription_id' => $data['subscription_id'], 'days' => $receipt['days'], 'created_at' => $now]);
            return $this->success($data['receipt_id'], false);
        }, 3);
    }
    private function success(string $receipt, bool $replayed) { return response()->json(['credited' => true, 'receipt_id' => $receipt, 'replayed' => $replayed], 200, ['Cache-Control' => 'no-store']); }
    private function unavailable() { return response()->json(['error' => 'activation_unavailable'], 503, ['Cache-Control' => 'no-store']); }
}
