<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

use Stellar\DesktopApi\Application\Ports\ServerCatalog;
use Stellar\DesktopApi\Domain\Server;

final readonly class FixtureServerCatalog implements ServerCatalog
{
    public function __construct(private string $path) {}

    public function all(): array
    {
        $raw = file_get_contents($this->path);
        if ($raw === false) throw new \RuntimeException('Fixture catalog unavailable.');
        $rows = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($rows) || !array_is_list($rows)) throw new \RuntimeException('Invalid catalog.');
        $servers = []; $ids = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !isset($row['id'], $row['name'], $row['country'], $row['lat'], $row['lon'])
                || !is_string($row['id']) || !is_string($row['name']) || !is_string($row['country'])
                || !is_numeric($row['lat']) || !is_numeric($row['lon'])) throw new \RuntimeException('Invalid catalog entry.');
            $server = new Server($row['id'], $row['name'], $row['country'], (float) $row['lat'], (float) $row['lon']);
            if (isset($ids[$server->id])) throw new \RuntimeException('Duplicate server ID.');
            $ids[$server->id] = true; $servers[] = $server;
        }
        return $servers;
    }
}
