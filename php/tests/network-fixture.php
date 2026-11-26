<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/app/bootstrap.php';

$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$config = ProxyForge\configuration();
$config['check_url'] = $input['target'];
$config['ca_file'] = $input['ca'];
$network = new ProxyForge\Network($config, true);
$results = [];
$peak = 0;
$network->check($input['proxies'], 10000, static function ($proxy, $result) use (&$results): void {
    $results[$proxy['protocol'] . ':' . $proxy['port']] = $result;
}, static function ($metrics) use (&$peak): bool { $peak = max($peak, $metrics['peakActive']); return true; });
echo json_encode(['results' => $results, 'peak' => $peak], JSON_THROW_ON_ERROR);
