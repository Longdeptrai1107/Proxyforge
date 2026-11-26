<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/app/bootstrap.php';

use ProxyForge\CurlPool;
use ProxyForge\Engine;
use ProxyForge\NetworkDriver;
use ProxyForge\Parser;
use ProxyForge\Store;
use ProxyForge\Url;

function expect(bool $condition, string $message = 'Assertion failed'): void
{
    if (!$condition) { throw new RuntimeException($message); }
}
function same(mixed $expected, mixed $actual): void
{
    expect($expected === $actual, 'Expected ' . json_encode($expected) . ', received ' . json_encode($actual));
}
function rejects(callable $call): void
{
    try { $call(); } catch (Throwable) { return; }
    throw new RuntimeException('Expected an exception.');
}
function temporaryStore(): Store
{
    $config = ProxyForge\configuration();
    $config['data_dir'] = sys_get_temp_dir() . '/proxyforge-php-test-' . bin2hex(random_bytes(8));
    $config['enrich_geo'] = false;
    return new Store($config);
}
function cleanup(string $path): void
{
    // Only directories created by this suite are passed here.
    foreach (scandir($path) as $name) {
        if ($name !== '.' && $name !== '..') { unlink($path . '/' . $name); }
    }
    rmdir($path);
}
final class FakeNetwork implements NetworkDriver
{
    public $onCollect = null;
    public $onCheck = null;
    public int $collections = 0;
    public function collect(array $sources, callable $result, callable $tick): bool
    {
        $this->collections++;
        if ($this->onCollect) { return ($this->onCollect)($sources, $result, $tick); }
        $result($sources[0]['id'], Parser::parse('8.8.8.8:8080 1.1.1.1:1080'), null, 1);
        return $tick([]);
    }
    public function check(array $proxies, int $concurrency, callable $result, callable $tick): bool
    {
        same(10000, $concurrency);
        if ($this->onCheck) { return ($this->onCheck)($proxies, $result, $tick); }
        foreach ($proxies as $proxy) {
            $result($proxy, ['status' => $proxy['host'] === '8.8.8.8' ? 'alive' : 'dead', 'latencyMs' => 2, 'checkedAt' => ProxyForge\timestamp(), 'exitIP' => '9.9.9.9']);
            if (!$tick([])) { return false; }
        }
        return true;
    }
}

$tests = [];
$tests['public IP, URL boundaries and redirects'] = static function (): void {
    foreach (['8.8.8.8', '2606:4700:4700::1111'] as $ip) { expect(Parser::publicIP($ip), $ip); }
    foreach (['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'ff02::1', '::ffff:8.8.8.8', '2002:0808:0808::', '2001:db8::1'] as $ip) { expect(!Parser::publicIP($ip), $ip); }
    foreach (['http://example.com/', 'https://127.0.0.1/', 'https://user:pass@example.com/', 'https://example.com:444/', 'https://localhost/', 'https://x.local/'] as $url) { rejects(static fn() => Url::validate($url)); }
    same('https://example.com/feed', Url::validate('https://example.com/feed#anchor'));
    same('https://example.com/b', Url::resolve('https://example.com/folder/a', '../b'));
    rejects(static fn() => Url::resolve('https://example.com/', '//127.0.0.1/a'));
};
$tests['text parser rejects private endpoints, auth and invalid ports'] = static function (): void {
    $text = '8.8.8.8:8080 http://8.8.8.8:8080 socks5://1.1.1.1:1080 socks4://[2606:4700:4700::1111]:4145 127.0.0.1:80 user:pass@8.8.4.4:80 8.8.8.8:70000';
    same(['http://8.8.8.8:8080', 'socks5://1.1.1.1:1080', 'socks4://[2606:4700:4700::1111]:4145'], array_map([Parser::class, 'key'], Parser::parse($text)));
};
$tests['JSON protocol and server metadata are preserved without HTTP duplicates'] = static function (): void {
    $text = json_encode(['proxies' => [['ip' => '8.8.8.8', 'port' => 1080, 'proxy' => '8.8.8.8:1080', 'protocol' => 'SOCKS5', 'ip_data' => ['countryCode' => 'VN', 'city' => 'Hanoi', 'as' => 'AS7552 Viettel', 'isp' => 'Viettel']]]]);
    $rows = Parser::parse($text);
    same(1, count($rows)); same('socks5', $rows[0]['protocol']); same('VN', $rows[0]['countryCode']); same('Hanoi', $rows[0]['city']); same(7552, $rows[0]['asn']); same('Viettel', $rows[0]['server']);
    same('https', Parser::parse('["https://8.8.8.8:443"]')[0]['protocol']);
};
$tests['HTML rows, restricted Base64 and XOR decoding skip documentation'] = static function (): void {
    $text = '<script>Proxy("' . base64_encode('8.8.8.8:8080') . '")</script><table><tr><td><script>document.write(atob("' . base64_encode('8.8.8.8') . '"))</script></td><td>8081</td></tr><tr data-protos="HTTP|SOCKS5"><td>46.232.249.209:40001</td></tr><tr><td><span>8.8.4.4</span><span>:8082</span></td><td>HTTP</td></tr><tr data-p="' . base64_encode('0808:8.8.8.8') . '"><td></td><td>HTTP</td></tr><tr><td>1.1.1.1<script>document.write((y^x)+(y^x)+(y^x)+(w^z))</script></td><td>HTTP</td></tr></table><script>x=9;y=9^x;z=2;w=0^z;</script>';
    $keys = array_map([Parser::class, 'key'], Parser::parse($text));
    foreach (['http://8.8.8.8:8080', 'http://8.8.8.8:8081', 'http://8.8.4.4:8082', 'http://1.1.1.1:9990', 'socks5://46.232.249.209:40001'] as $key) { expect(in_array($key, $keys, true), $key); }
    same(['socks5://8.8.8.8:1080'], array_map([Parser::class, 'key'], Parser::parse('<pre>http://1.2.3.4:8080</pre><script>example="http://1.2.3.4:80"</script><tr><td>8.8.8.8:1080</td><td>SOCKS5</td></tr>')));
};
$tests['CSV import round trips exported columns, quoted metadata and explicit protocols'] = static function (): void {
    $csv = "protocol,host,port,status,countryCode,city,server,asn\r\n"
        . "socks5,8.8.8.8,1080,alive,VN,Hanoi,\"Fixture, Network\nSecond line\",7552\r\n"
        . "http,127.0.0.1,8080,alive,US,Local,Private,0\r\n";
    $rows = Parser::parse($csv);
    same(1, count($rows)); same('socks5', $rows[0]['protocol']); same('VN', $rows[0]['countryCode']);
    same("Fixture, Network\nSecond line", $rows[0]['server']); same(7552, $rows[0]['asn']);
    expect(!isset($rows[0]['status']), 'Imported status must not make a proxy live.');
    same('https', Parser::parse("\xEF\xBB\xBFIP Address;Port;Type\n1.1.1.1;443;HTTPS")[0]['protocol']);
    same([], Parser::parse("ip,port,username,password\n8.8.8.8,80,user,secret"));
};
$tests['50 distinct source websites and 249 countries are bundled'] = static function (): void {
    $sources = json_decode(file_get_contents(dirname(__DIR__) . '/resources/sources.json'), true);
    same(50, count($sources)); same(50, count(array_unique(array_column($sources, 'publisher'))));
    same(50, count(array_unique(array_map(static fn($source) => parse_url($source['url'], PHP_URL_HOST), $sources))));
    same(249, count(json_decode(file_get_contents(dirname(__DIR__) . '/assets/countries.json'), true)));
    foreach ($sources as $source) { foreach ($source['feeds'] ?? [$source] as $feed) { Url::validate($feed['url']); expect(!str_contains(strtolower($feed['url']), 'github')); } }
};
$tests['storage is guarded and OS locks prevent overlapping jobs'] = static function (): void {
    $store = temporaryStore();
    try {
        expect(str_starts_with(file_get_contents($store->directory . '/state.php'), Store::GUARD));
        $lock = $store->workerLock(); expect($lock !== false);
        same(false, $store->workerLock());
        same('busy', (new Engine($store, new FakeNetwork()))->run()['state']);
        flock($lock, LOCK_UN); fclose($lock);
        same(50, count($store->read()['sources']));
    } finally { cleanup($store->directory); }
};
$tests['backend starts immediately, freshly downloads, publishes live only and respects 60s schedule'] = static function (): void {
    $store = temporaryStore(); $network = new FakeNetwork(); $engine = new Engine($store, $network);
    try {
        same(true, $store->read()['automation']['enabled']);
        $result = $engine->run(); same('done', $result['state']); same(1, $result['live']);
        same(10000, $result['job']['options']['concurrency']); same(3000, $result['job']['options']['timeoutMs']);
        $saved = $store->read(); same(60000, $saved['automation']['nextRunAtMs'] - $saved['automation']['lastRunAtMs']);
        same(1, $engine->snapshot()['counts']['total']); same('alive', array_values($saved['proxies'])[0]['status']);
        same('idle', $engine->run()['state']); same(1, $network->collections);
        $store->update(static function (&$state) { $state['automation']['nextRunAtMs'] = 0; });
        same('done', $engine->run()['state']); same(2, $network->collections);
    } finally { cleanup($store->directory); }
};
$tests['old verified live stays visible until a failed recheck removes it'] = static function (): void {
    $store = temporaryStore(); $network = new FakeNetwork(); $engine = new Engine($store, $network);
    $old = Parser::parse('9.9.9.9:3128')[0] + ['status' => 'alive', 'latencyMs' => 5];
    try {
        $store->update(static function (&$state) use ($old) { $state['proxies'] = [Parser::key($old) => $old]; });
        $network->onCollect = static function ($sources, $result, $tick) use ($engine) { same(1, $engine->snapshot()['counts']['total']); $result($sources[0]['id'], Parser::parse('8.8.8.8:8080'), null, 1); return $tick([]); };
        same('done', $engine->run()['state']);
        same(['8.8.8.8'], array_column($engine->filtered([]), 'host'));
        same(1, $store->read()['job']['removed']);
    } finally { cleanup($store->directory); }
};
$tests['stop persists partial successes and untouched previous live results'] = static function (): void {
    $store = temporaryStore(); $network = new FakeNetwork(); $engine = new Engine($store, $network);
    $old = Parser::parse('9.9.9.9:3128')[0] + ['status' => 'alive'];
    try {
        $store->update(static function (&$state) use ($old) { $state['proxies'] = [Parser::key($old) => $old]; });
        $network->onCheck = static function ($proxies, $result, $tick) use ($engine) {
            $proxy = $proxies['http://8.8.8.8:8080'];
            $result($proxy, ['status' => 'alive', 'latencyMs' => 1]);
            $engine->stop(); usleep(160000); return $tick([]);
        };
        same('stopped', $engine->run()['state']);
        same(2, $engine->snapshot()['counts']['alive']); same(false, $store->read()['automation']['enabled']);
        same('paused', $engine->run()['state']); same(false, (new Store($store->config))->read()['automation']['enabled']);
        $engine->auto(true); expect($store->read()['refreshRequested']);
    } finally { cleanup($store->directory); }
};
$tests['import is queued without being published and filters never expose unchecked results'] = static function (): void {
    $store = temporaryStore(); $engine = new Engine($store, new FakeNetwork());
    try {
        same(1, $engine->import('8.8.8.8:8080 127.0.0.1:90', 'http'));
        same([], $engine->filtered(['status' => 'all'])); same(1, $engine->snapshot()['queued']);
        $engine->run(); same(0, $engine->snapshot()['queued']); same(1, count($engine->filtered(['status' => 'all'])));
        same([], $engine->filtered(['status' => 'pending'])); same([], $engine->filtered(['country' => 'VN']));
        same(1, count($engine->filtered(['country' => 'unknown', 'protocol' => 'http'])));
        $engine->clear(); same([], $engine->filtered([]));
    } finally { cleanup($store->directory); }
};
$tests['crashed worker recovers safely when automation is paused'] = static function (): void {
    $store = temporaryStore(); $engine = new Engine($store, new FakeNetwork());
    try {
        $store->update(static function (&$state) { $state['automation']['enabled'] = false; $state['job'] = ['state' => 'running', 'active' => 30, 'startedAtMs' => 1]; });
        same('paused', $engine->run()['state']); same('stopped', $store->read()['job']['state']); same(0, $store->read()['job']['active']);
    } finally { cleanup($store->directory); }
};
$tests['minute cron tolerates scheduler jitter without skipping a complete minute'] = static function (): void {
    $store = temporaryStore(); $engine = new Engine($store, new FakeNetwork());
    try {
        $store->update(static function (&$state) { $state['automation']['nextRunAtMs'] = ProxyForge\now() + 500; });
        same('idle', $engine->run(false, 'worker-cli')['state']);
        same('done', $engine->run(false, 'cron-cli')['state']);
    } finally { cleanup($store->directory); }
};
$tests['streamed IPv4 and IPv6 country data override ASN registration and retain provider metadata'] = static function (): void {
    $store = temporaryStore();
    try {
        file_put_contents($store->directory . '/ip2asn-v4-u32.tsv.gz', gzencode("134744064\t134744319\t7552\tUS\tFixture Network\n"));
        file_put_contents($store->directory . '/ip2asn-v6.tsv.gz', gzencode("2606:4700:4700::\t2606:4700:4700::ffff\t13335\tUS\tCloudflare\n"));
        file_put_contents($store->directory . '/dbip-country-lite-' . gmdate('Y-m') . '.csv.gz', gzencode("8.8.8.0,8.8.8.255,VN\n2606:4700:4700::,2606:4700:4700::ffff,CA\n"));
        $proxies = Parser::parse('8.8.8.8:8080 socks5://[2606:4700:4700::1111]:1080');
        $proxies[0]['city'] = 'Hanoi';
        [$rows, $warning] = (new ProxyForge\Geo($store, new ProxyForge\Network($store->config)))->enrich($proxies, static fn() => true);
        same(null, $warning); same('VN', $rows[0]['countryCode']); same(7552, $rows[0]['asn']); same('Hanoi', $rows[0]['city']);
        same('CA', $rows[1]['countryCode']); same(13335, $rows[1]['asn']); same('DB-IP Lite', $rows[1]['locationSource']);
    } finally { cleanup($store->directory); }
};
$tests['curl_multi admits 10000 handles before waiting and queues candidate 10001'] = static function (): void {
    $file = tempnam(sys_get_temp_dir(), 'pf-pool-'); file_put_contents($file, 'controlled');
    $completed = 0; $peak = 0;
    try {
        $tasks = (static function () { for ($index = 0; $index < 10001; $index++) { yield $index; } })();
        $pool = new CurlPool();
        $finished = $pool->run($tasks, 10000, static function ($index) use ($file, &$completed) {
            if ($index === 10000) { expect($completed > 0, 'Candidate 10001 started before a slot was free.'); }
            $path = str_replace('\\', '/', realpath($file));
            $handle = curl_init('file:///' . ltrim($path, '/'));
            curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
            return [$handle, (object) []];
        }, static function ($task, $context, $handle, $error) use (&$completed) { expect(!$error, (string) $error); same('controlled', curl_multi_getcontent($handle)); $completed++; return []; }, static function ($metrics) use (&$peak) { $peak = max($peak, $metrics['peakActive']); return true; });
        expect($finished); same(10000, $peak); same(10001, $completed);
    } finally { unlink($file); }
};

$passed = 0;
foreach ($tests as $name => $test) {
    try { $test(); $passed++; echo "PASS: $name\n"; }
    catch (Throwable $error) { fwrite(STDERR, "FAIL: $name\n" . $error . "\n"); exit(1); }
}
echo "OK: $passed PHP tests; no external libraries.\n";
