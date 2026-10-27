<?php
return [
    // Avoid inheriting database/Redis connections from any older API.
    'default' => env('APP_ENV') === 'testing' ? 'array' : 'file',
    'stores' => ['array' => ['driver' => 'array', 'serialize' => false],
        'file' => ['driver' => 'file', 'path' => storage_path('framework/cache/data'), 'lock_path' => storage_path('framework/cache/data')]],
    'prefix' => 'stellar_desktop_v2_fixture_',
];
