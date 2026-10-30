<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;

use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\SubscriptionGateway;
use Stellar\DesktopApi\Domain\Subscription;

/** Read-only adapter using the existing reviewed Laravel HTTP runtime; no extra SDK. */
final readonly class SubscriptionApiGateway implements SubscriptionGateway, \Stellar\DesktopApi\Application\Ports\SelectedSubscriptionGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $username,
        #[\SensitiveParameter] private string $password) {}

    public function forAccount(string $accountId): ?Subscription
    {
        return $this->read($accountId, null);
    }
    public function forSelection(string $accountId, string $subscriptionHash): ?Subscription
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $subscriptionHash)) throw new IntegrationUnavailable();
        return $this->read($accountId, $subscriptionHash);
    }
    private function read(string $accountId, ?string $subscriptionHash): ?Subscription
    {
        if (!preg_match('/^[1-9][0-9]*$/D', $accountId) || $this->username === '' || $this->password === ''
            || str_contains($this->username, ':') || preg_match('/[\x00-\x1f\x7f]/', $this->username.$this->password)) {
            throw new IntegrationUnavailable('Subscription integration unavailable.');
        }
        try {
            $response = $this->http->withBasicAuth($this->username, $this->password)->acceptJson()
                ->withHeaders(['Cache-Control' => 'no-store'])
                ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                    'connect_timeout' => 5, 'timeout' => 15, 'stream' => true])
                ->get('https://stellersubscriptionapiprod.azurewebsites.net/api/v1/subscriptioncontroller/user/subscriptions',
                    ['user_id' => $accountId, 'type' => 1]);
            $stream = $response->toPsrResponse()->getBody();
            try {
                $raw = '';
                while (!$stream->eof() && strlen($raw) <= 65536) {
                    $part = $stream->read(65537 - strlen($raw));
                    if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                    $raw .= $part;
                }
            } finally { $stream->close(); }
            if ($response->status() !== 200 || strlen($raw) > 65536
                || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new \RuntimeException();
            return self::decode(json_decode($raw, true, 32, JSON_THROW_ON_ERROR), $accountId, $subscriptionHash);
        } catch (\Throwable) {
            // No upstream bodies, identifiers, credentials or chained HTTP exceptions.
            throw new IntegrationUnavailable('Subscription integration unavailable.');
        }
    }

    public static function decode(mixed $rows, string $accountId, ?string $subscriptionHash = null): ?Subscription
    {
        if (!is_array($rows) || !array_is_list($rows) || count($rows) > 100) throw new \UnexpectedValueException();
        $subscriptions = [];
        foreach ($rows as $row) {
            if (!is_array($row) || (string) ($row['user_id'] ?? '') !== $accountId
                || !in_array($row['type'] ?? null, [1, '1'], true)
                || !(is_string($row['id'] ?? null) || is_int($row['id'] ?? null)) || !preg_match('/^[A-Za-z0-9-]{1,128}$/D', (string) $row['id'])
                || !in_array($row['status'] ?? null, [0, 1, 2, '0', '1', '2'], true)) throw new \UnexpectedValueException();
            $expiry = $row['expires_at'] ?? null;
            $date = null;
            if ($expiry !== null) {
                if (!is_string($expiry) || !preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/D', $expiry)) throw new \UnexpectedValueException();
                $date = new \DateTimeImmutable($expiry, new \DateTimeZone('UTC'));
                $errors = \DateTimeImmutable::getLastErrors();
                if ($errors !== false && ($errors['warning_count'] || $errors['error_count'])) throw new \UnexpectedValueException();
            }
            $status = match ((int) $row['status']) { 1 => 'active', 2 => 'trial', default => 'inactive' };
            if ($date !== null && $date <= new \DateTimeImmutable('now')) $status = 'expired';
            if (($row['meta']['activate_on_login'] ?? null) === true && ($row['meta']['activated'] ?? null) === false) {
                $status = 'pending'; $date = null;
            }
            $subscriptions[] = new Subscription((string) $row['id'], $status, $date);
        }
        // Match legacy DashboardController::home: upstream oldest-first, first record.
        if ($subscriptionHash !== null) {
            $subscriptions = array_values(array_filter($subscriptions, fn ($subscription) => hash_equals($subscriptionHash, hash('sha256', $subscription->id))));
            if (count($subscriptions) > 1) throw new \UnexpectedValueException();
        }
        return $subscriptions[0] ?? null;
    }

    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
