<?php
declare(strict_types=1);

namespace Stellar\DesktopApi\Domain;

final readonly class Session
{
    public function __construct(
        #[\SensitiveParameter] private string $accessToken,
        public string $accountId,
        public \DateTimeImmutable $expiresAt,
    ) {
        if ($accessToken === '' || $accountId === '') throw new \InvalidArgumentException('Invalid session.');
    }

    public function accessToken(): string { return $this->accessToken; }

    public function __debugInfo(): array { return ['accessToken' => '[redacted]', 'accountId' => '[redacted]']; }
}
