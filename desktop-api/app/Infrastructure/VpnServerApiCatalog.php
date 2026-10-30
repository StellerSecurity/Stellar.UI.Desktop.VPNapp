<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\ServerCatalog;
use Stellar\DesktopApi\Application\Ports\VpnConfigurationGateway;
use Stellar\DesktopApi\Domain\Server;

/** HTTPS-only live list. Signature verification is explicitly deferred for staging. */
final readonly class VpnServerApiCatalog implements ServerCatalog, VpnConfigurationGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $username,
        #[\SensitiveParameter] private string $password) {}
    public function all(): array
    {
        return array_map(fn ($row) => new Server($row['id'], $row['name'], $row['country'], (float) $row['lat'], (float) $row['lon']), $this->rows());
    }
    public function configuration(string $serverId): array
    {
        if (!preg_match('/^[a-z0-9-]{1,64}$/D', $serverId)) throw new \InvalidArgumentException('Invalid server.');
        foreach ($this->rows() as $row) {
            if ($row['id'] !== $serverId) continue;
            try {
                $response = $this->http->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                    'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])->get($row['config_url']);
                // No service Authorization header is ever sent to the configuration host.
                $config = self::read($response, 131072);
                if ($response->status() !== 200 || !hash_equals($row['config_sha256'], hash('sha256', $config))) throw new \RuntimeException();
                return ['server_id' => $serverId, 'config' => $config, 'sha256' => $row['config_sha256']];
            } catch (\Throwable) { throw new IntegrationUnavailable('VPN configuration is unavailable.'); }
        }
        throw new \InvalidArgumentException('Unknown server.');
    }
    private function rows(): array
    {
        try {
            if ($this->username === '' || $this->password === '' || str_contains($this->username, ':')
                || preg_match('/[\x00-\x1f\x7f]/', $this->username.$this->password)) throw new \RuntimeException();
            $response = $this->http->withBasicAuth($this->username, $this->password)->acceptJson()
                ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                    'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])
                ->get('https://stellarvpnapiprod.azurewebsites.net/api/v1/vpnservercontroller/list');
            $raw = self::read($response, 262144);
            if ($response->status() !== 200 || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new \RuntimeException();
            return self::decode(json_decode($raw, true, 32, JSON_THROW_ON_ERROR));
        } catch (\Throwable) { throw new IntegrationUnavailable('VPN locations are unavailable.'); }
    }
    private static function read($response, int $limit): string
    {
        $stream = $response->toPsrResponse()->getBody();
        try {
            $raw = '';
            while (!$stream->eof() && strlen($raw) <= $limit) {
                $part = $stream->read($limit + 1 - strlen($raw));
                if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                $raw .= $part;
            }
            if (strlen($raw) > $limit) throw new \RuntimeException();
            return $raw;
        } finally { $stream->close(); }
    }
    public static function decode(mixed $rows): array
    {
        if (!is_array($rows) || !array_is_list($rows) || count($rows) > 500) throw new \UnexpectedValueException();
        $seen = []; $result = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !is_string($row['id'] ?? null) || isset($seen[$row['id']])
                || !is_string($row['name'] ?? null) || !is_string($row['country'] ?? null)
                || !is_numeric($row['lat'] ?? null) || !is_numeric($row['lon'] ?? null)
                || !is_string($row['config_url'] ?? null)
                || !preg_match('~^https://vpnconfigs\.stellarsecurity\.com/openvpn/[A-Za-z0-9_/-]+\.ovpn$~D', $row['config_url'])
                || str_contains($row['config_url'], '//openvpn') || str_contains($row['config_url'], '..')
                || !is_string($row['config_sha256'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $row['config_sha256'])) throw new \UnexpectedValueException();
            new Server($row['id'], $row['name'], $row['country'], (float) $row['lat'], (float) $row['lon']);
            $seen[$row['id']] = true;
            $result[] = array_intersect_key($row, array_flip(['id', 'name', 'country', 'lat', 'lon', 'config_url', 'config_sha256']));
        }
        return $result;
    }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
