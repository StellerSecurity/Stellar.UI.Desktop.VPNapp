<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application\Ports;
interface DeviceGateway
{
    /** @return list<array{id: string, name: string}> */
    public function forSubscription(string $subscriptionId): array;
}
