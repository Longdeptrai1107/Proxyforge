<?php
declare(strict_types=1);

namespace ProxyForge;

require_once __DIR__ . '/Parser.php';
require_once __DIR__ . '/Store.php';
require_once __DIR__ . '/Network.php';
require_once __DIR__ . '/Geo.php';
require_once __DIR__ . '/Engine.php';
require_once __DIR__ . '/Auth.php';

function configuration(): array
{
    $config = require dirname(__DIR__) . '/config.php';
    $local = dirname(__DIR__) . '/config.local.php';
    if (is_file($local)) {
        $overrides = require $local;
        if (!is_array($overrides)) {
            throw new \RuntimeException('config.local.php phải trả một array.');
        }
        $config = array_replace($config, $overrides);
    }
    $config['concurrency'] = max(1, min(10000, (int) $config['concurrency']));
    $config['max_proxies'] = max(1, min(100000, (int) $config['max_proxies']));
    return $config;
}

function timestamp(): string
{
    return gmdate('Y-m-d\TH:i:s') . sprintf('.%03dZ', (int) (microtime(true) * 1000) % 1000);
}

function now(): int
{
    return (int) round(microtime(true) * 1000);
}

function runtimeCheck(): void
{
    if (PHP_VERSION_ID < 80200 || PHP_INT_SIZE < 8) {
        throw new \RuntimeException('Cần PHP 8.2 trở lên, bản 64-bit.');
    }
    foreach (['curl', 'openssl'] as $extension) {
        if (!extension_loaded($extension)) {
            throw new \RuntimeException('Hãy bật extension PHP ' . $extension . ' trong hosting.');
        }
    }
}
