<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

final class StagingPolicy
{
    // Deployment guard, NOT a network firewall. No live adapters exist in this foundation.
    public static function assertFixtureMode(string $environment, string $mode, ?string $azureSite): void
    {
        if (!in_array($environment, ['staging', 'testing'], true) || $mode !== 'fixture'
            || ($azureSite !== null && $azureSite !== 'stellar-desktop-vpn-staging')) {
            throw new \RuntimeException('Desktop API fixture mode requires an explicitly isolated staging/testing environment.');
        }
    }
}
