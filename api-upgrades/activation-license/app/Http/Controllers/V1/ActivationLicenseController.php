<?php

namespace App\Http\Controllers\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\V1\CreateActivationLicenseRequest;
use App\Models\ActivationLicense;
use App\Services\ActivationLicenseService;
use App\Status;
use App\Type;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class ActivationLicenseController extends Controller
{
    public function create(
        CreateActivationLicenseRequest $request,
        ActivationLicenseService $activationLicenseService
    ): JsonResponse {
        $validated = $request->validated();
        $type = (int) $validated['type'];

        $idempotentLicense = $this->findIdempotentLicense($validated);
        if ($idempotentLicense !== null) {
            return $this->idempotentReplayResponse($idempotentLicense, $validated);
        }

        $customCodeAlreadyExists = isset($validated['code'])
            && ActivationLicense::where('code', $validated['code'])
                ->where('type', $type)
                ->exists();

        if ($customCodeAlreadyExists) {
            return response()->json([
                'response_code' => 409,
                'response_message' => 'An activation license with this code and type already exists.',
            ], 409);
        }

        try {
            $licenses = $activationLicenseService->create($validated);
        } catch (QueryException $exception) {
            $idempotentLicense = $this->findIdempotentLicense($validated);

            if ($idempotentLicense !== null) {
                return $this->idempotentReplayResponse($idempotentLicense, $validated);
            }

            report($exception);

            return $this->creationFailedResponse();
        } catch (RuntimeException $exception) {
            report($exception);

            return $this->creationFailedResponse();
        }

        return response()->json([
            'response_code' => 201,
            'response_message' => $licenses->count() === 1
                ? 'Activation license created.'
                : 'Activation licenses created.',
            'count' => $licenses->count(),
            'idempotent_replay' => false,
            'licenses' => $licenses->values(),
        ], 201, [
            'Cache-Control' => 'no-store',
        ]);
    }

    /**
     * The endpoint returns the license and its subscription duration.
     */
    public function activate(Request $request): JsonResponse
    {
        $code = $request->input('code');
        $type = $request->input('type');
        $activate = $request->input('activate');

        if ($type === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'No type provided']);
        }

        try {
            $enumType = Type::from($type);
        } catch (\ValueError) {
            return response()->json(['response_code' => 400, 'response_message' => $type.' is not a valid type']);
        }

        if ($code === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'No code provided']);
        }

        if ($activate === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'Activate is missing']);
        }

        return \Illuminate\Support\Facades\DB::transaction(function () use ($code, $enumType, $activate) {
        $activationLicense = ActivationLicense::where([
            ['code', $code],
            ['type', $enumType->value],
        ])->lockForUpdate()->first();

        if ($activationLicense === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'Activation license not found']);
        }

        if ($activationLicense->status === Status::INACTIVE->value) {
            return response()->json([
                'response_code' => 400,
                'response_message' => 'Activation license is not active and cannot be used.',
            ]);
        }

        if ($activationLicense->status === Status::ACTIVATED->value) {
            return response()->json([
                'response_code' => 400,
                'response_message' => 'Activation license has already been activated.',
            ]);
        }

        if ((int) $activate === 1) {
            $activationLicense->status = Status::ACTIVATED->value;
            $activationLicense->save();
        }

        return response()->json(['response_code' => 200, 'license' => $activationLicense]);
        }, 3);
    }

    /**
     * The endpoint verifies the license and returns its subscription duration.
     */
    public function verify(Request $request): JsonResponse
    {
        $code = $request->input('code');
        $type = $request->input('type');

        if ($type === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'No type provided']);
        }

        try {
            $enumType = Type::from($type);
        } catch (\ValueError) {
            return response()->json(['response_code' => 400, 'response_message' => $type.' is not a valid type']);
        }

        if ($code === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'No code provided']);
        }

        $activationLicense = ActivationLicense::where([
            ['code', $code],
            ['type', $enumType->value],
        ])->first();

        if ($activationLicense === null) {
            return response()->json(['response_code' => 400, 'response_message' => 'Activation license not found']);
        }

        if ($activationLicense->status === Status::INACTIVE->value) {
            return response()->json([
                'response_code' => 400,
                'response_message' => 'Activation license is not active and cannot be used.',
            ]);
        }

        if ($activationLicense->status === Status::ACTIVATED->value) {
            return response()->json([
                'response_code' => 400,
                'response_message' => 'Activation license has already been activated.',
            ]);
        }

        return response()->json(['response_code' => 200, 'license' => $activationLicense]);
    }

    private function findIdempotentLicense(array $validated): ?ActivationLicense
    {
        $idempotencyKey = $validated['idempotency_key'] ?? null;

        if (! is_string($idempotencyKey) || $idempotencyKey === '') {
            return null;
        }

        return ActivationLicense::query()
            ->where('type', (int) $validated['type'])
            ->where('idempotency_key', $idempotencyKey)
            ->first();
    }

    private function idempotentReplayResponse(
        ActivationLicense $license,
        array $validated
    ): JsonResponse {
        if ((int) $license->subscriptions_days !== (int) $validated['subscriptions_days']) {
            return response()->json([
                'response_code' => 409,
                'response_message' => 'The idempotency key was already used with different subscription days.',
            ], 409, [
                'Cache-Control' => 'no-store',
            ]);
        }

        return response()->json([
            'response_code' => 200,
            'response_message' => 'Existing activation license returned.',
            'count' => 1,
            'idempotent_replay' => true,
            'licenses' => [$license],
        ], 200, [
            'Cache-Control' => 'no-store',
        ]);
    }

    private function creationFailedResponse(): JsonResponse
    {
        return response()->json([
            'response_code' => 500,
            'response_message' => 'The activation license could not be created.',
        ], 500, [
            'Cache-Control' => 'no-store',
        ]);
    }
}

