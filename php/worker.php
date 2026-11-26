<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/app/bootstrap.php';

try {
    ProxyForge\runtimeCheck();
    @set_time_limit(0);
    $engine = new ProxyForge\Engine(new ProxyForge\Store(ProxyForge\configuration()));
    $engine->auto(true);
    do {
        $result = $engine->run(false, 'worker-cli');
        if (!in_array($result['state'], ['idle', 'paused', 'busy'], true)) {
            echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
        }
        if (in_array('--once', $argv, true)) {
            exit($result['state'] === 'error' ? 1 : 0);
        }
        usleep(500000);
    } while (true);
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
}
