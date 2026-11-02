<?php
// For dependency-free unit tests only. Never loads vendor or third-party code.
spl_autoload_register(static function (string $class): void {
    $prefix = 'Stellar\\DesktopApi\\';
    if (!str_starts_with($class, $prefix)) return;
    $name = substr($class, strlen($prefix));
    if (!preg_match('/^[A-Za-z0-9_\\\\]+$/D', $name)) return;
    $path = dirname(__DIR__).'/app/'.str_replace('\\', '/', $name).'.php';
    if (is_file($path)) require $path;
});
