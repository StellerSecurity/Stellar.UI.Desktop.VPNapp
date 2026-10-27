<?php
declare(strict_types=1);

namespace Stellar\DesktopApi\Domain;

final readonly class Server
{
    public function __construct(
        public string $id,
        public string $name,
        public string $countryCode,
        public float $latitude,
        public float $longitude,
    ) {
        if (!preg_match('/^[a-z0-9-]{1,64}$/D', $id)
            || trim($name) === '' || strlen($name) > 255
            || !preg_match('/^[A-Z]{2}$/D', $countryCode)
            || !is_finite($latitude) || !is_finite($longitude)
            || abs($latitude) > 90 || abs($longitude) > 180) {
            throw new \InvalidArgumentException('Invalid server catalog entry.');
        }
    }
}
