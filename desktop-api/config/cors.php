<?php
return [
    'paths' => ['api/v2/*'],
    'allowed_methods' => ['GET', 'POST', 'OPTIONS'],
    'allowed_origins' => ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost',
        'http://127.0.0.1:4176', 'http://127.0.0.1:4177'],
    'allowed_origins_patterns' => [],
    'allowed_headers' => ['Accept', 'Content-Type', 'Authorization'],
    'exposed_headers' => ['X-Request-ID', 'Retry-After', 'X-Stellar-Retry-Safe'],
    'max_age' => 600,
    'supports_credentials' => false,
];
