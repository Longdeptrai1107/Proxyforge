<?php
declare(strict_types=1);

use ProxyForge\Auth;
use ProxyForge\Engine;
use ProxyForge\Store;

require __DIR__ . '/app/bootstrap.php';

function respond(mixed $value, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
    exit;
}

try {
    ProxyForge\runtimeCheck();
    $config = ProxyForge\configuration();
    $store = new Store($config);
    $auth = new Auth($store);
    $auth->requireLogin();
    $engine = new Engine($store);
    $action = (string) ($_GET['action'] ?? 'state');
    $reads = ['state', 'sources', 'proxies', 'export', 'info'];
    $writes = ['auto', 'stop', 'refresh', 'collect', 'check', 'import', 'clear', 'sources/toggle', 'sources/add', 'logout'];
    if (!in_array($action, array_merge($reads, $writes), true)) {
        respond(['error' => 'Không có API này.'], 404);
    }
    $method = $_SERVER['REQUEST_METHOD'];
    if (($method !== 'GET' && in_array($action, $reads, true)) || ($method !== 'POST' && in_array($action, $writes, true))) {
        header('Allow: ' . (in_array($action, $reads, true) ? 'GET' : 'POST'));
        respond(['error' => 'Phương thức HTTP không được hỗ trợ.'], 405);
    }
    $body = [];
    if ($method === 'POST') {
        $auth->verifyCsrf($_SERVER['HTTP_X_PROXY_FORGE_TOKEN'] ?? null);
        if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) {
            respond(['error' => 'Yêu cầu JSON.'], 415);
        }
        $raw = file_get_contents('php://input', false, null, 0, 8 * 1024 * 1024 + 1);
        if (strlen($raw) > 8 * 1024 * 1024) {
            respond(['error' => 'Nội dung nhập tối đa 8 MB.'], 413);
        }
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($body)) {
            throw new InvalidArgumentException('Cần một đối tượng JSON.');
        }
    }
    switch ($action) {
        case 'sources':
            respond($store->read()['sources']);
        case 'proxies':
            respond($engine->list($_GET));
        case 'info':
            $script = realpath(__DIR__ . '/cron.php');
            respond(['cronCommand' => '* * * * * php ' . escapeshellarg($script),
                'workerCommand' => 'php ' . escapeshellarg(realpath(__DIR__ . '/worker.php')),
                'cronToken' => $store->read()['auth']['cronToken'],
                'php' => PHP_VERSION, 'curl' => curl_version()['version'], 'memoryLimit' => ini_get('memory_limit')]);
        case 'export':
            $rows = $engine->filtered($_GET);
            $format = in_array($_GET['format'] ?? '', ['txt', 'csv', 'json'], true) ? $_GET['format'] : 'txt';
            header('Content-Type: ' . ['txt' => 'text/plain', 'csv' => 'text/csv', 'json' => 'application/json'][$format] . '; charset=utf-8');
            header('Content-Disposition: attachment; filename="proxyforge-live-' . gmdate('Ymd-His') . '.' . $format . '"');
            if ($format === 'json') {
                echo json_encode($rows, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
            } elseif ($format === 'txt') {
                foreach ($rows as $row) {
                    echo ($_GET['bare'] ?? '') === '1' ? explode('://', $row['id'], 2)[1] . "\n" : $row['id'] . "\n";
                }
            } else {
                $out = fopen('php://output', 'wb');
                $fields = ['protocol', 'host', 'port', 'status', 'latencyMs', 'exitIP', 'checkedAt', 'countryCode', 'country', 'city', 'server', 'asn'];
                fputcsv($out, $fields, ',', '"', '', "\r\n");
                foreach ($rows as $row) {
                    $values = array_map(static function ($key) use ($row) {
                        $value = (string) ($row[$key] ?? '');
                        return preg_match('/^[=+@-]/', $value) ? "'" . $value : $value;
                    }, $fields);
                    fputcsv($out, $values, ',', '"', '', "\r\n");
                }
                fclose($out);
            }
            exit;
        case 'auto':
            if (!is_bool($body['enabled'] ?? true)) {
                throw new InvalidArgumentException('Trạng thái tự động không hợp lệ.');
            }
            $engine->auto($body['enabled'] ?? true, isset($body['concurrency']) ? (int) $body['concurrency'] : null, isset($body['limit']) ? (int) $body['limit'] : null);
            break;
        case 'stop':
            $engine->stop();
            break;
        case 'refresh':
        case 'collect':
        case 'check':
            $engine->requestRefresh();
            break;
        case 'import':
            if (!is_string($body['text'] ?? null) || !is_string($body['protocol'] ?? 'http')) {
                throw new InvalidArgumentException('Danh sách nhập không hợp lệ.');
            }
            $added = $engine->import($body['text'], $body['protocol'] ?? 'http');
            respond($engine->snapshot() + ['added' => $added, 'token' => $auth->csrf], 202);
        case 'sources/toggle':
            if (!is_array($body['ids'] ?? null) || !is_bool($body['enabled'] ?? null)) {
                throw new InvalidArgumentException('Danh sách nguồn không hợp lệ.');
            }
            $engine->toggleSources($body['ids'], $body['enabled']);
            break;
        case 'sources/add':
            if (!is_string($body['url'] ?? null) || !is_string($body['name'] ?? '') || !is_string($body['protocol'] ?? 'http')) {
                throw new InvalidArgumentException('Nguồn không hợp lệ.');
            }
            $engine->addSource($body['url'], $body['name'] ?? '', $body['protocol'] ?? 'http');
            break;
        case 'clear':
            $engine->clear();
            break;
        case 'logout':
            $auth->logout();
            respond(['ok' => true]);
    }
    respond($engine->snapshot() + ['token' => $auth->csrf]);
} catch (JsonException | InvalidArgumentException | TypeError $error) {
    respond(['error' => 'Dữ liệu không hợp lệ: ' . substr($error->getMessage(), 0, 180)], 400);
} catch (UnexpectedValueException $error) {
    respond(['error' => $error->getMessage()], in_array($error->getCode(), [401, 403], true) ? $error->getCode() : 400);
} catch (Throwable $error) {
    respond(['error' => substr($error->getMessage(), 0, 220)], 409);
}
