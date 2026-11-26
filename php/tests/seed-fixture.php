<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/app/bootstrap.php';

$store = new ProxyForge\Store(ProxyForge\configuration());
$store->update(static function (&$state): void {
    foreach ($state['sources'] as &$source) { $source['enabled'] = false; }
    unset($source);
    $row = ['id' => 'http://8.8.8.8:8080', 'host' => '8.8.8.8', 'port' => 8080, 'protocol' => 'http', 'status' => 'alive',
        'countryCode' => 'VN', 'city' => 'Hanoi', 'asn' => 7552, 'server' => 'PHP Test ISP', 'latencyMs' => 42, 'exitIP' => '9.9.9.9'];
    $state['proxies'] = [$row['id'] => $row];
});
echo "Seeded isolated fixture.\n";
