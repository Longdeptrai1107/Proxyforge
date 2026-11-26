<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
require dirname(__DIR__) . '/app/bootstrap.php';
$store = new ProxyForge\Store(ProxyForge\configuration());
$store->update(static function (&$state): void { $state['auth']['passwordHash'] = password_hash('test-password-123', PASSWORD_DEFAULT); });
session_name('pf_' . substr(hash('sha256', dirname(__DIR__)), 0, 16));
session_start();
$_SESSION['authenticated'] = true;
$_SESSION['generation'] = 0;
session_write_close();
require dirname(__DIR__) . '/index.php';
