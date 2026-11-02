<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Application\ActivationRejected;

/** Fixed first-party endpoints; no legacy consume-then-patch fallback. */
final readonly class ActivationApiGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $username, #[\SensitiveParameter] private string $password,
        #[\SensitiveParameter] private string $subscriptionUsername, #[\SensitiveParameter] private string $subscriptionPassword) {}
    public function redeem(#[\SensitiveParameter] string $code, string $accountId, string $subscriptionId): void {
        $claim = $this->post('https://stellaractivationlicenseapiprod.azurewebsites.net/api/v1/vpn-redemptions/claim',
            ['code' => $code, 'account_id' => $accountId, 'subscription_id' => $subscriptionId], $this->username, $this->password);
        $receipt = $claim['receipt_id'] ?? null;
        if (!is_string($receipt) || !preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/D', $receipt)
            || ($claim['account_id'] ?? null) !== $accountId || ($claim['subscription_id'] ?? null) !== $subscriptionId
            || ($claim['type'] ?? null) !== 1) throw new IntegrationUnavailable();
        $credit = $this->post('https://stellersubscriptionapiprod.azurewebsites.net/api/v1/subscriptioncontroller/license-credit',
            ['receipt_id' => $receipt, 'account_id' => $accountId, 'subscription_id' => $subscriptionId], $this->subscriptionUsername, $this->subscriptionPassword);
        if (($credit['credited'] ?? null) !== true || ($credit['receipt_id'] ?? null) !== $receipt) throw new IntegrationUnavailable();
    }
    private function post(string $url, #[\SensitiveParameter] array $body, #[\SensitiveParameter] string $username, #[\SensitiveParameter] string $password): array {
        if (!$username || !$password || str_contains($username, ':') || preg_match('/[\x00-\x1f\x7f]/', $username.$password)) throw new IntegrationUnavailable();
        try {
            // Replay is safe via receipt protocol, but no blind retries on this financial mutation.
            $response = $this->http->withBasicAuth($username, $password)->acceptJson()
                ->withHeaders(['Cache-Control' => 'no-store'])->withOptions(['allow_redirects' => false, 'http_errors' => false,
                    'verify' => true, 'connect_timeout' => 4, 'timeout' => 10, 'stream' => true])->post($url, $body);
            $stream = $response->toPsrResponse()->getBody();
            try {
                $raw = '';
                while (!$stream->eof() && strlen($raw) <= 8192) {
                    $part = $stream->read(8193 - strlen($raw));
                    if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                    $raw .= $part;
                }
                if (strlen($raw) > 8192) throw new \RuntimeException();
            }
            finally { $stream->close(); }
            $status = $response->status();
            if ($status === 409) throw new ActivationRejected();
            if ($status !== 200 || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new \RuntimeException();
            $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($data)) throw new \RuntimeException();
            return $data;
        } catch (ActivationRejected) { throw new ActivationRejected(); }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
    }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
