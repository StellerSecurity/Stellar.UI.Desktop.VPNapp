<?php
namespace App\Http\Controllers\V1;
use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Internal basicAuth routes only. Never accept a user-supplied duration. */
class VpnRedemptionController extends Controller
{
    public function claim(Request $request) {
        $data = $request->validate([
            'code' => ['required', 'string', 'max:128', 'regex:/\A[A-Za-z0-9-]{4,128}\z/'],
            'account_id' => ['required', 'string', 'max:32', 'regex:/\A[1-9][0-9]*\z/'],
            'subscription_id' => ['required', 'string', 'max:128', 'regex:/\A[A-Za-z0-9-]+\z/'],
        ]);
        return DB::transaction(function () use ($data) {
            $license = DB::table('activationlicenses')->where('code', $data['code'])->where('type', 1)->lockForUpdate()->first();
            if (!$license) return $this->invalid();
            $receipt = DB::table('vpn_license_redemptions')->where('license_id', (string) $license->id)->first();
            if ($receipt) {
                if ($receipt->account_id !== $data['account_id'] || $receipt->subscription_id !== $data['subscription_id']) return $this->invalid();
                return $this->receipt($receipt);
            }
            $days = (int) $license->subscriptions_days;
            if ((int) $license->status !== 1 || $days < 1 || $days > 36500) return $this->invalid();
            $receipt = (object) ['id' => (string) Str::uuid(), 'license_id' => (string) $license->id,
                'account_id' => $data['account_id'], 'subscription_id' => $data['subscription_id'], 'days' => $days, 'created_at' => now()];
            DB::table('vpn_license_redemptions')->insert((array) $receipt);
            DB::table('activationlicenses')->where('id', $license->id)->update(['status' => 2, 'updated_at' => now()]);
            return $this->receipt($receipt);
        }, 3);
    }
    public function show(Request $request) {
        $data = $request->validate(['receipt_id' => ['required', 'uuid']]);
        $receipt = DB::table('vpn_license_redemptions')->where('id', $data['receipt_id'])->first();
        return $receipt ? $this->receipt($receipt) : $this->invalid();
    }
    private function receipt(object $receipt) {
        return response()->json(['receipt_id' => $receipt->id, 'account_id' => $receipt->account_id,
            'subscription_id' => $receipt->subscription_id, 'type' => 1, 'days' => (int) $receipt->days], 200, ['Cache-Control' => 'no-store']);
    }
    private function invalid() { return response()->json(['error' => 'invalid_activation_code'], 409, ['Cache-Control' => 'no-store']); }
}
