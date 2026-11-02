<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\Ports\VpnCredentialGateway;
use Stellar\DesktopApi\Domain\VpnCredentials;

/** First-party equivalent of Android's add-device + issueCredentials. */
final readonly class VpnCredentialApiGateway implements VpnCredentialGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $deviceUsername,
        #[\SensitiveParameter] private string $devicePassword,
        #[\SensitiveParameter] private string $vpnUsername,
        #[\SensitiveParameter] private string $vpnPassword) {}

    public function issueForLogin(string $accountId, string $subscriptionId): VpnCredentials
    {
        try {
            if (!preg_match('/^[1-9][0-9]{0,17}$/D', $accountId)
                || !preg_match('/^[A-Za-z0-9-]{1,128}$/D', $subscriptionId)) throw new \RuntimeException();
            // Check both integrations before the first mutation.
            self::validateServiceAuth($this->deviceUsername, $this->devicePassword);
            self::validateServiceAuth($this->vpnUsername, $this->vpnPassword);
            $name = DeviceName::random();
            $device = $this->post('https://stellardevicesapiprod.azurewebsites.net/api/v1/devicecontroller/add',
                $this->deviceUsername, $this->devicePassword, ['identifier' => $subscriptionId, 'name' => $name]);
            $id = $device['id'] ?? null;
            if (!is_string($id) || !preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/Di', $id)
                || ($device['identifier'] ?? null) !== $subscriptionId || ($device['name'] ?? null) !== $name) throw new \RuntimeException();
            $issued = $this->post('https://stellarvpnapiprod.azurewebsites.net/api/v1/vpncredentialcontroller/credentials',
                $this->vpnUsername, $this->vpnPassword, ['user_id' => (int) $accountId, 'device_id' => $id]);
            $data = $issued['data'] ?? null;
            if (($issued['response_code'] ?? null) !== 200 || !is_array($data)
                || !is_string($data['username'] ?? null) || !is_string($data['password'] ?? null)) throw new \RuntimeException();
            return new VpnCredentials($data['username'], $data['password'], $id);
        } catch (\Throwable) {
            // HTTP exceptions may contain Authorization or a one-time password. Never chain them.
            throw new IntegrationUnavailable('VPN authentication is unavailable.');
        }
    }
    private static function validateServiceAuth(#[\SensitiveParameter] string $username, #[\SensitiveParameter] string $password): void
    {
        if ($username === '' || $password === '' || str_contains($username, ':')
            || preg_match('/[\x00-\x1f\x7f]/', $username.$password)) throw new \RuntimeException();
    }
    private function post(string $url, #[\SensitiveParameter] string $username, #[\SensitiveParameter] string $password, array $body): array
    {
        $response = $this->http->withBasicAuth($username, $password)->acceptJson()->asJson()
            ->withHeaders(['Cache-Control' => 'no-store'])
            ->withOptions(['allow_redirects' => false, 'http_errors' => false, 'verify' => true,
                'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])->post($url, $body);
        $stream = $response->toPsrResponse()->getBody();
        try {
            $raw = '';
            while (!$stream->eof() && strlen($raw) <= 16384) {
                $part = $stream->read(16385 - strlen($raw));
                if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                $raw .= $part;
            }
        } finally { $stream->close(); }
        if ($response->status() !== 200 || strlen($raw) > 16384
            || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new \RuntimeException();
        $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($data) || array_is_list($data)) throw new \RuntimeException();
        return $data;
    }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
