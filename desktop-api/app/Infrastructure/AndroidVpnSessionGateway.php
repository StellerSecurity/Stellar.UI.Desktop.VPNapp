<?php
declare(strict_types=1);
namespace Stellar\DesktopApi\Infrastructure;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Http\Client\Response;
use Stellar\DesktopApi\Application\IdentityRejected;
use Stellar\DesktopApi\Application\IntegrationUnavailable;
use Stellar\DesktopApi\Domain\Session;

/** Compatibility boundary for Android's existing ['vpn'] token; never accepts wildcard tokens. */
final readonly class AndroidVpnSessionGateway
{
    public function __construct(private ScopedUserApiClient $users, private Repository $cache) {}
    private function key(#[\SensitiveParameter] string $token): string { return 'android-vpn-session:'.hash('sha256', $token); }
    private function record(#[\SensitiveParameter] string $token): mixed
    {
        try { return $this->cache->get($this->key($token)); }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
    }
    public function handles(#[\SensitiveParameter] string $token): bool { return $this->record($token) !== null; }
    private function save(#[\SensitiveParameter] string $token, array $record): void
    {
        try {
            if (!$this->cache->put($this->key($token), $record, max(1, $record['expires'] - time()))) throw new \RuntimeException();
        } catch (\Throwable) { throw new IntegrationUnavailable(); }
    }
    private function decode(Response $response): array
    {
        $stream = $response->toPsrResponse()->getBody();
        try {
            $raw = '';
            while (!$stream->eof() && strlen($raw) <= 65536) {
                $part = $stream->read(65537 - strlen($raw));
                if ($part === '' && !$stream->eof()) throw new \RuntimeException();
                $raw .= $part;
            }
        } catch (\Throwable) { throw new IntegrationUnavailable(); }
        finally { $stream->close(); }
        if ($response->status() === 429) throw new IdentityRejected('rate_limited', 429);
        if ($response->status() === 404) throw new IdentityRejected('invalid_credentials', 401);
        if ($response->status() !== 200 || strlen($raw) > 65536
            || strtolower(explode(';', $response->header('Content-Type'))[0]) !== 'application/json') throw new IntegrationUnavailable();
        try { $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
        if (!is_array($data)) throw new IntegrationUnavailable();
        if (($data['response_code'] ?? null) !== 200) throw new IdentityRejected('invalid_session', 401);
        return $data;
    }
    private function user(string $owner): array
    {
        try { $response = $this->users->androidUser($owner); }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
        return $this->decode($response);
    }
    private function metadata(#[\SensitiveParameter] string $token): array
    {
        try { $response = $this->users->androidToken($token); }
        catch (\Throwable) { throw new IntegrationUnavailable(); }
        return $this->decode($response);
    }
    private function verified(#[\SensitiveParameter] string $token, array $data, string $owner): Session
    {
        $meta = $data['token'] ?? null;
        if (!is_array($meta) || ($meta['name'] ?? null) !== 'Stellar.VPN' || ($meta['abilities'] ?? null) !== ['vpn']
            || (string) ($meta['tokenable_id'] ?? '') !== $owner || ($meta['tokenable_type'] ?? null) !== 'App\\Models\\User'
            || (string) ($meta['id'] ?? '') !== explode('|', $token, 2)[0]) throw new IdentityRejected('invalid_session', 401);
        $created = $this->date($meta['created_at'] ?? null);
        $expiry = $created->modify('+24 hours');
        if (($meta['expires_at'] ?? null) !== null) $expiry = min($expiry, $this->date($meta['expires_at']));
        if ($created->getTimestamp() > time() + 60 || $expiry->getTimestamp() <= time()) throw new IdentityRejected('invalid_session', 401);
        return new Session($token, $owner, $expiry);
    }
    private function date(mixed $value): \DateTimeImmutable
    {
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/D', $value)) throw new IntegrationUnavailable();
        try {
            $date = new \DateTimeImmutable($value, new \DateTimeZone('UTC'));
            $errors = \DateTimeImmutable::getLastErrors();
            if ($errors !== false && ($errors['warning_count'] || $errors['error_count'])) throw new \RuntimeException();
            return $date;
        } catch (\Throwable) { throw new IntegrationUnavailable(); }
    }
    public function issue(string $owner, string $subscriptionHash): Session
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $subscriptionHash)) throw new IntegrationUnavailable();
        $data = $this->user($owner);
        $token = $data['token'] ?? null;
        if ((string) ($data['user']['id'] ?? '') !== $owner || !is_string($token)
            || !preg_match('/^[1-9][0-9]*\|[A-Za-z0-9]{40}$/D', $token)) throw new IdentityRejected('invalid_credentials', 401);
        $session = $this->verified($token, $this->metadata($token), $owner);
        $existing = $this->record($token);
        if ($existing !== null) throw new IdentityRejected('invalid_session', 401);
        // The private server cache contains a token digest and fixed metadata only, never the bearer or account number.
        $this->save($token, ['owner' => $owner, 'expires' => $session->expiresAt->getTimestamp(), 'subscription' => $subscriptionHash, 'revoked' => false]);
        return new Session($token, $owner, $session->expiresAt, $subscriptionHash);
    }
    public function inspect(#[\SensitiveParameter] string $token): Session
    {
        $record = $this->record($token);
        if (!is_array($record) || ($record['revoked'] ?? null) !== false || !is_string($record['owner'] ?? null)
            || !is_string($record['subscription'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $record['subscription'])
            || !is_int($record['expires'] ?? null) || $record['expires'] <= time()) throw new IdentityRejected('invalid_session', 401);
        $session = $this->verified($token, $this->metadata($token), $record['owner']);
        if ($this->record($token) !== $record) throw new IdentityRejected('invalid_session', 401);
        return new Session($token, $session->accountId, min($session->expiresAt, new \DateTimeImmutable('@'.$record['expires'])), $record['subscription']);
    }
    public function revoke(#[\SensitiveParameter] string $token): void
    {
        $record = $this->record($token);
        if (!is_array($record) || !is_int($record['expires'] ?? null)) throw new IdentityRejected('invalid_session', 401);
        // Revoke desktop access only. Other Android/VPN sessions are deliberately untouched.
        $record['revoked'] = true;
        $this->save($token, $record);
    }
}
