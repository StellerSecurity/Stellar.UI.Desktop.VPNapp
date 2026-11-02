<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;

use Stellar\DesktopApi\Domain\Server;

interface ServerCatalog
{
    /** @return list<Server> */
    public function all(): array;
}
