<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Application;

/** Safe application failure; never contains upstream bodies or credentials. */
final class IdentityRejected extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $httpStatus)
    {
        parent::__construct('The identity request was rejected.');
    }
}
