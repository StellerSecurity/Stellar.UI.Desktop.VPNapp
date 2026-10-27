<?php
return [
    'name' => 'Stellar Desktop API',
    // No default environment may silently enable the staging-only foundation.
    'env' => env('APP_ENV', 'unconfigured'),
    'debug' => false,
    'url' => env('APP_URL', 'http://127.0.0.1'),
    'timezone' => 'UTC',
    'locale' => 'en',
    'fallback_locale' => 'en',
    'key' => env('APP_KEY'),
    'cipher' => 'AES-256-CBC',
    'maintenance' => ['driver' => 'file'],
];
