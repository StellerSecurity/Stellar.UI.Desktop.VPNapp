<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Http\Client\Factory;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;

/** Same subscription lookup as Android accountNumber(); deferred activation remains upstream. */
final readonly class AnonymousAccountGateway
{
    public function __construct(private Factory $http,
        #[\SensitiveParameter] private string $username, #[\SensitiveParameter] private string $password) {}
    public function owner(#[\SensitiveParameter] string $number): string
    {
        if (!preg_match('/^[0-9]{16}$/D', $number)) throw new IdentityRejected('invalid_input', 422);
        if (!$this->username || !$this->password || str_contains($this->username, ':')
            || preg_match('/[\x00-\x1f\x7f]/', $this->username.$this->password)) throw new IntegrationUnavailable();
        try {
            $response = $this->http->withBasicAuth($this->username, $this->password)->acceptJson()->asJson()
                ->withHeaders(['Cache-Control' => 'no-store'])->withOptions(['allow_redirects' => false, 'http_errors' => false,
                    'verify' => true, 'connect_timeout' => 5, 'timeout' => 10, 'stream' => true])
                ->get('https://stellersubscriptionapiprod.azurewebsites.net/api/v1/subscriptioncontroller/find/'.$number, ['type' => 1]);
            $stream = $response->toPsrResponse()->getBody();
            try {
                $raw = '';
                while (!$stream->eof() && strlen($raw) <= 8192) {
                    $part = $stream->read(8193 - strlen($raw));
                    if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                    $raw .= $part;
                }
            } finally { $stream->close(); }
            if ($response->status() === 404) throw new IdentityRejected('invalid_credentials', 401);
            if ($response->status() === 429) throw new IdentityRejected('rate_limited', 429);
            if ($response->status() !== 200 || strlen($raw) > 8192
                || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new \RuntimeException();
            $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
            if ($data === null) throw new IdentityRejected('invalid_credentials', 401);
            if (!is_array($data) || (string) ($data['id'] ?? '') !== $number
                || !in_array($data['type'] ?? null, [1, '1'], true)) throw new IdentityRejected('invalid_credentials', 401);
            if (!(is_string($data['user_id'] ?? null) || is_int($data['user_id'] ?? null))
                || !preg_match('/^[1-9][0-9]*$/D', (string) $data['user_id'])) throw new \RuntimeException();
            return (string) $data['user_id'];
        } catch (IdentityRejected $failure) { throw $failure; }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
    }
    public function __debugInfo(): array { return ['credentials' => '[redacted]']; }
}
