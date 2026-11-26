<?php
declare(strict_types=1);

// Copy settings you want to override into config.local.php (return an array).
return [
    'data_dir' => getenv('PROXYFORGE_PHP_DATA') ?: __DIR__ . '/storage',
    'concurrency' => 10000,
    'max_proxies' => 100000,
    'check_url' => 'https://api.iplocate.io/ip',
    'ca_file' => null, // Optional absolute path to the hosting provider's CA bundle.
    'enrich_geo' => true,
];
