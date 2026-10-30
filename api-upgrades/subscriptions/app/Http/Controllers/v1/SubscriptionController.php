<?php

namespace App\Http\Controllers\v1;

use App\Helpers\IdHelper;
use App\Http\Controllers\Controller;
use App\Models\Subscription;
use App\SubscriptionSource;
use App\SubscriptionStatus;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class SubscriptionController extends Controller
{
    /**
     * Create a subscription.
     *
     * Existing subscriptions keep the legacy behaviour: expires_at is used
     * immediately unless meta.activate_on_login is explicitly true.
     */
    public function add(Request $request): JsonResponse
    {
        $data = $request->only([
            'user_id',
            'type',
            'expires_at',
            'status',
            'source',
            'source_meta',
            'reseller_user_id',
            'id',
            'plan_id',
            'activated_at',
            'meta',
        ]);

        if (array_key_exists('source', $data)) {
            $data['source'] = SubscriptionSource::normalize($data['source']);
        }

        if ($request->input('id') === null || $request->input('id') == 1977 || $request->input('id') == 1988) {
            $data['id'] = Str::uuid();
        }

        if ($request->input('pretty_id') == 1) {
            $data['id'] = IdHelper::makePrettyId();
        }

        $meta = is_array($data['meta'] ?? null) ? $data['meta'] : [];

        // Deferred activation is strictly opt-in. Missing metadata retains the
        // existing immediate expires_at behaviour without modification.
        if ($this->metaBoolean($meta, 'activate_on_login')) {
            $days = $this->validatedActivationDays($meta);

            $meta['activate_on_login'] = true;
            $meta['activation_days'] = $days;
            $meta['activated'] = false;

            $data['meta'] = $meta;
            $data['activated_at'] = null;
            $data['status'] = SubscriptionStatus::INACTIVE->value;
        }

        $subscription = Subscription::create($data);

        return response()->json($subscription);
    }

    // Returns a list of subscriptions a reseller has sold.
    public function reseller(int $reseller_user_id, Request $request): JsonResponse
    {
        $subscriptions = Subscription::where('reseller_user_id', $reseller_user_id)
            ->orderBy('created_at', 'desc')
            ->get();

        return response()->json($subscriptions);
    }

    public function findusersubscriptions(Request $request): JsonResponse
    {
        $user_id = $request->get('user_id');

        if ($user_id === null) {
            return response()->json(null, 400);
        }

        $where['user_id'] = $user_id;

        if ($request->input('type') !== null) {
            $where['type'] = $request->input('type');
        }

        if ($request->input('source') !== null) {
            $where['source'] = SubscriptionSource::normalize($request->input('source'));
        }

        // OLDEST first, never change sorting.
        $subscriptions = Subscription::where($where)
            ->orderBy('created_at', 'asc')
            ->get();

        return response()->json($subscriptions);
    }

    /**
     * Find a subscription.
     *
     * The response contract is unchanged.
     *
     * A subscription is automatically activated only when it contains valid,
     * canonical deferred-activation metadata and has not already been activated.
     */
    public function find(Request $request, string $id): JsonResponse
    {
        $subscription = Subscription::find($id);

        if ($subscription === null) {
            return response()->json(null, 200);
        }

        $meta = is_array($subscription->meta)
            ? $subscription->meta
            : [];

        if (
            $this->hasValidDeferredActivationMeta($meta)
            && $meta['activated'] === false
        ) {
            $result = $this->activateDeferredSubscription($id);

            if ($result['subscription'] !== null) {
                $subscription = $result['subscription'];
            }
        }

        return response()->json($subscription, 200);
    }

    public function delete(Request $request): JsonResponse
    {
        $id = $request->input('id');

        if ($id === null) {
            return response()->json([], 400);
        }

        $subscription = Subscription::find($id);

        if ($subscription === null) {
            return response()->json([], 400);
        }

        $subscription->delete();

        return response()->json([], 200);
    }

    public function patch(Request $request): JsonResponse
    {
        $id = $request->input('id');

        if ($id === null) {
            return response()->json([], 400);
        }

        $subscription = Subscription::find($id);

        if ($subscription === null) {
            return response()->json([], 400);
        }

        $data = $request->only([
            'status',
            'source',
            'source_meta',
            'reseller_user_id',
            'id',
            'plan_id',
            'user_id',
            'expires_at',
            'activated_at',
            'meta',
        ]);

        if (array_key_exists('source', $data)) {
            $data['source'] = SubscriptionSource::normalize($data['source']);
        }

        $subscription->fill($data)->save();

        return response()->json($subscription, 200);
    }

    /**
     * Activate one explicitly deferred subscription.
     */
    public function activate(string $id): JsonResponse
    {
        $result = $this->activateDeferredSubscription($id);

        if ($result['subscription'] === null) {
            return response()->json([
                'message' => 'Subscription not found.',
            ], 404);
        }

        if (!$result['uses_deferred_activation']) {
            return response()->json([
                'message' => 'Subscription does not use activate-on-login.',
                'subscription' => $result['subscription'],
            ], 409);
        }

        return response()->json([
            'activated_now' => $result['activated_now'],
            'subscription' => $result['subscription'],
        ], 200);
    }

    /**
     * Atomically activate a deferred subscription when required.
     *
     * Invalid, malformed, legacy, or immediate subscription metadata is never
     * modified by this method.
     *
     * @return array{
     *     subscription: Subscription|null,
     *     uses_deferred_activation: bool,
     *     activated_now: bool
     * }
     */
    private function activateDeferredSubscription(string $id): array
    {
        return DB::transaction(function () use ($id): array {
            /** @var Subscription|null $subscription */
            $subscription = Subscription::query()
                ->lockForUpdate()
                ->find($id);

            if ($subscription === null) {
                return [
                    'subscription' => null,
                    'uses_deferred_activation' => false,
                    'activated_now' => false,
                ];
            }

            $meta = is_array($subscription->meta)
                ? $subscription->meta
                : [];

            // Never activate or modify subscriptions with malformed or
            // non-canonical deferred-activation metadata.
            if (!$this->hasValidDeferredActivationMeta($meta)) {
                return [
                    'subscription' => $subscription,
                    'uses_deferred_activation' => false,
                    'activated_now' => false,
                ];
            }

            if ($meta['activated'] === true) {
                return [
                    'subscription' => $subscription,
                    'uses_deferred_activation' => true,
                    'activated_now' => false,
                ];
            }

            $days = $meta['activation_days'];
            $activatedAt = Carbon::now();

            $baseDate = $subscription->expires_at !== null
            && $subscription->expires_at->greaterThan($activatedAt)
                ? $subscription->expires_at->copy()
                : $activatedAt->copy();

            $meta['activate_on_login'] = true;
            $meta['activation_days'] = $days;
            $meta['activated'] = true;
            $meta['activated_at'] = $activatedAt->toIso8601String();

            $subscription->forceFill([
                'activated_at' => $activatedAt,
                'expires_at' => $baseDate->addDays($days),
                'status' => SubscriptionStatus::ACTIVE->value,
                'meta' => $meta,
            ])->save();

            return [
                'subscription' => $subscription->fresh(),
                'uses_deferred_activation' => true,
                'activated_now' => true,
            ];
        });
    }

    public function scheduler(): JsonResponse
    {
        // Deferred subscriptions must not be changed by expires_at until their
        // first-login activation has occurred. Every legacy subscription still
        // follows the original expires_at scheduler logic.
        $eligible = static function ($query): void {
            $query->whereNull('meta')
                ->orWhereRaw(
                    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.activate_on_login')), 'false') <> 'true'"
                )
                ->orWhereRaw(
                    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.activated')), 'false') = 'true'"
                );
        };

        Subscription::query()
            ->where($eligible)
            ->where('expires_at', '<=', Carbon::now())
            ->where('status', '!=', SubscriptionStatus::INACTIVE->value)
            ->update([
                'status' => SubscriptionStatus::INACTIVE->value,
            ]);

        $data = Subscription::query()
            ->where($eligible)
            ->where('expires_at', '>=', Carbon::now())
            ->where('status', '=', SubscriptionStatus::INACTIVE->value)
            ->update([
                'status' => SubscriptionStatus::ACTIVE->value,
            ]);

        return response()->json($data);
    }

    /**
     * Determine whether metadata is canonical and safe for deferred activation.
     */
    private function hasValidDeferredActivationMeta(array $meta): bool
    {
        if (!array_key_exists('activate_on_login', $meta)) {
            return false;
        }

        if ($meta['activate_on_login'] !== true) {
            return false;
        }

        if (!array_key_exists('activated', $meta)) {
            return false;
        }

        if (!is_bool($meta['activated'])) {
            return false;
        }

        if (!array_key_exists('activation_days', $meta)) {
            return false;
        }

        if (!is_int($meta['activation_days'])) {
            return false;
        }

        if ($meta['activation_days'] < 1 || $meta['activation_days'] > 3650) {
            return false;
        }

        return true;
    }

    private function metaBoolean(array $meta, string $key): bool
    {
        return filter_var(
            $meta[$key] ?? false,
            FILTER_VALIDATE_BOOLEAN
        );
    }

    private function validatedActivationDays(array $meta): int
    {
        $days = filter_var(
            $meta['activation_days'] ?? null,
            FILTER_VALIDATE_INT,
            [
                'options' => [
                    'min_range' => 1,
                    'max_range' => 3650,
                ],
            ]
        );

        if ($days === false) {
            throw ValidationException::withMessages([
                'meta.activation_days' => 'activation_days must be an integer between 1 and 3650.',
            ]);
        }

        return $days;
    }
}

