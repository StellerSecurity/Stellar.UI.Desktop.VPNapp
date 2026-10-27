<?php
declare(strict_types=1);

namespace Stellar\DesktopApi\Domain;

final readonly class LoginCredentials
{
    private string $password;

    public function __construct(public string $username, #[\SensitiveParameter] string $password)
    {
        if (trim($username) === '' || strlen($username) > 254 || $password === '' || strlen($password) > 1024) {
            throw new \InvalidArgumentException('A username and password are required within supported lengths.');
        }
        $this->password = $password;
    }

    public function password(): string { return $this->password; }

    public function __debugInfo(): array { return ['username' => '[redacted]', 'password' => '[redacted]']; }
}
