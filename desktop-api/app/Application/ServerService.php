<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;

use Stellar\DesktopApi\Application\Ports\ServerCatalog;
use Stellar\DesktopApi\Domain\Server;

final readonly class ServerService
{
    public function __construct(private ServerCatalog $catalog) {}

    /** @return list<Server> */
    public function list(?string $country = null): array
    {
        if ($country !== null && !preg_match('/^[A-Z]{2}$/D', $country)) {
            throw new \InvalidArgumentException('country must be a two-letter uppercase country code.');
        }
        return array_values(array_filter($this->catalog->all(), fn (Server $s): bool => $country === null || $s->countryCode === $country));
    }
}
