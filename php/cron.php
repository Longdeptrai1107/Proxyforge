<?php
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

$cli = PHP_SAPI === 'cli';
try {
    ProxyForge\runtimeCheck();
    $store = new ProxyForge\Store(ProxyForge\configuration());
    if (!$cli) {
        ProxyForge\Auth::headers();
        header('Content-Type: application/json; charset=utf-8');
        $key = $_SERVER['HTTP_X_PROXY_FORGE_CRON'] ?? $_GET['key'] ?? '';
        if (!is_string($key) || !hash_equals($store->read()['auth']['cronToken'], $key)) {
            http_response_code(403);
            echo json_encode(['error' => 'Khóa cron không hợp lệ.']);
            exit;
        }
    }
    @set_time_limit(0);
    ignore_user_abort(true);
    $result = (new ProxyForge\Engine($store))->run(false, $cli ? 'cron-cli' : 'cron-http');
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    if ($cli && $result['state'] === 'error') {
        exit(1);
    }
} catch (Throwable $error) {
    if (!$cli) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['error' => $error->getMessage()], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    if ($cli) {
        exit(1);
    }
}
