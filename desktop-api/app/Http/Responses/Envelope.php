<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Http\Responses;

use Illuminate\Http\JsonResponse;

final class Envelope
{
    private static function respond(array $body, int $status): JsonResponse
    {
        $requestId = bin2hex(random_bytes(16));
        return new JsonResponse($body + ['meta' => ['api_version' => 'v2', 'mode' => 'fixture', 'request_id' => $requestId]],
            $status, ['Cache-Control' => 'no-store', 'X-Request-ID' => $requestId, 'X-Content-Type-Options' => 'nosniff']);
    }
    public static function success(array $data): JsonResponse { return self::respond(['data' => $data], 200); }
    public static function error(string $code, string $message, int $status): JsonResponse
    {
        return self::respond(['error' => ['code' => $code, 'message' => $message]], $status);
    }
}
