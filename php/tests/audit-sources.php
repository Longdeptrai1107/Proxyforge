<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/app/bootstrap.php';
ProxyForge\runtimeCheck();
$sources = json_decode(file_get_contents(dirname(__DIR__) . '/resources/sources.json'), true, 512, JSON_THROW_ON_ERROR);
$results = [];
(new ProxyForge\Network(ProxyForge\configuration()))->collect($sources, static function ($id, $proxies, $error, $duration) use (&$results): void {
    $results[$id] ??= ['id' => $id, 'count' => 0, 'protocols' => [], 'errors' => [], 'durationMs' => 0];
    $results[$id]['count'] += count($proxies);
    $results[$id]['durationMs'] += $duration;
    $results[$id]['protocols'] = array_values(array_unique(array_merge($results[$id]['protocols'], array_column($proxies, 'protocol'))));
    if ($error) { $results[$id]['errors'][] = $error; }
}, static fn($metrics) => true);
$report = ['checkedAt' => ProxyForge\timestamp(), 'total' => count($sources), 'readable' => count(array_filter($results, static fn($row) => $row['count'] > 0)), 'results' => array_values($results)];
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR) . "\n";
