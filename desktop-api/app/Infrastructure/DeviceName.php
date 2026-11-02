<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

/** Matches StellarDevice::randomName(false), without an additional runtime package.
 * Name data: stellar-laravel-devices v1.0.1, resources/names.json,
 * commit eb4403af667d8c66efdbe9ceccfaafd7ec8a4965.
 * Names are display labels, not unique identifiers or authentication secrets.
 */
final class DeviceName
{
    public static function random(): string
    {
        static $names = null;
        if ($names === null) {
            $data = json_decode(file_get_contents(dirname(__DIR__, 2).'/resources/device-names.json'), true, 4, JSON_THROW_ON_ERROR);
            if (!is_array($data['names'] ?? null) || !$data['names']) throw new \UnexpectedValueException('Invalid device name pool.');
            $pool = [];
            foreach ($data['names'] as $name) {
                if (!is_string($name) || !trim($name) || strlen($name) > 120 || preg_match('/[\x00-\x1f\x7f]/', $name)) throw new \UnexpectedValueException('Invalid device name.');
                $pool[] = trim($name);
            }
            $names = array_values(array_unique($pool));
        }
        return $names[random_int(0, count($names) - 1)];
    }
}
