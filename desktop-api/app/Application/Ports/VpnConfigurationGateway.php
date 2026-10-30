<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;

interface VpnConfigurationGateway
{
    /** Returns only a catalog-selected, checksum-verified configuration. */
    public function configuration(string $serverId): array;
}
