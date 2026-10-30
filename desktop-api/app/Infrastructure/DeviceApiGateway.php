<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\DeviceGateway;

/** Same read-only list operation as Android DeviceService::devices. No add/delete. */
final readonly class DeviceApiGateway implements DeviceGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $username,
        #[\SensitiveParameter] private string $password) {}

    public function forSubscription(string $subscriptionId): array
    {
        try {
            if (!preg_match('/^[A-Za-z0-9-]{1,128}$/D', $subscriptionId) || $this->username === '' || $this->password === ''
                || str_contains($this->username, ':') || preg_match('/[\x00-\x1f\x7f]/', $this->username.$this->password)) throw new \RuntimeException();
            $response = $this->http->withBasicAuth($this->username, $this->password)->acceptJson()
                ->withHeaders(['Cache-Control' => 'no-store'])
                ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                    'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])
                ->get('https://stellardevicesapiprod.azurewebsites.net/api/v1/devicecontroller/devices', ['identifier' => $subscriptionId]);
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
            return self::decode(json_decode($raw, true, 32, JSON_THROW_ON_ERROR), $subscriptionId);
        } catch (\Throwable) { throw new IntegrationUnavailable('Device integration unavailable.'); }
    }

    public static function decode(mixed $rows, string $subscriptionId): array
    {
        if (!is_array($rows) || !array_is_list($rows) || count($rows) > 200) throw new \UnexpectedValueException();
        $devices = []; $seen = [];
        foreach ($rows as $row) {
            if (!is_array($row) || (string) ($row['identifier'] ?? '') !== $subscriptionId
                || !(is_int($row['id'] ?? null) || is_string($row['id'] ?? null)) || !preg_match('/^(?:[1-9][0-9]*|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/Di', (string) $row['id'])
                || !is_string($row['name'] ?? null) || trim($row['name']) === '' || strlen($row['name']) > 120
                || preg_match('/[\x00-\x1f\x7f]/', $row['name']) || isset($seen[(string) $row['id']])) throw new \UnexpectedValueException();
            $seen[(string) $row['id']] = true;
            $devices[] = ['id' => (string) $row['id'], 'name' => $row['name']];
        }
        return $devices;
    }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
