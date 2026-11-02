<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Domain;

final readonly class Subscription
{
    public function __construct(public string $id, public string $status, public ?\DateTimeImmutable $expiresAt) {}
    public function toArray(): array
    {
        return ['id' => $this->id, 'status' => $this->status, 'expires_at' => $this->expiresAt?->format(DATE_ATOM)];
    }
}
