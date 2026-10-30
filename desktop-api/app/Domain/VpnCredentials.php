<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Domain;

/** One-time secret: never include in account DTOs, logs or debug output. */
final readonly class VpnCredentials
{
    public function __construct(
        #[\SensitiveParameter] private string $username,
        #[\SensitiveParameter] private string $password,
        public string $deviceId,
    ) {
        if (!preg_match('/^stvpn_[a-f0-9]{16}$/D', $username)
            || !preg_match('/^[a-f0-9]{32}$/D', $password)
            || !preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/Di', $deviceId)) {
            throw new \InvalidArgumentException('Invalid VPN credentials.');
        }
    }
    public function forLoginResponse(): array { return ['username' => $this->username, 'password' => $this->password, 'device_id' => $this->deviceId]; }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
