<?php
return [
    // No request/password/token/exception export during fixture setup.
    // An approved, redacted operational logger is a later live-mode requirement.
    'default' => 'null',
    'channels' => ['null' => ['driver' => 'monolog', 'handler' => Monolog\Handler\NullHandler::class]],
    'deprecations' => ['channel' => 'null', 'trace' => false],
];
