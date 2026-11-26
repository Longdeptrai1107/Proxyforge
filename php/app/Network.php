<?php
declare(strict_types=1);

namespace ProxyForge;

interface NetworkDriver
{
    public function collect(array $sources, callable $result, callable $tick): bool;
    public function check(array $proxies, int $concurrency, callable $result, callable $tick): bool;
}

final class Url
{
    public static function validate(string $url): string
    {
        $parts = parse_url($url);
        $host = strtolower(trim($parts['host'] ?? '', '[]'));
        if (strlen($url) > 2048 || preg_match('/[\x00-\x20\x7f]/', $url) || !$parts || ($parts['scheme'] ?? '') !== 'https'
            || !$host || isset($parts['user'], $parts['pass']) || isset($parts['user']) || isset($parts['pass'])
            || ($parts['port'] ?? 443) !== 443 || str_ends_with($host, '.local') || str_ends_with($host, '.localhost') || $host === 'localhost') {
            throw new \InvalidArgumentException('Nguồn cần URL HTTPS công khai, cổng 443, không chứa tài khoản.');
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            if (!Parser::publicIP($host)) {
                throw new \InvalidArgumentException('Không được dùng địa chỉ mạng riêng hoặc địa chỉ đặc biệt.');
            }
        } elseif (!preg_match('/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/D', $host)) {
            throw new \InvalidArgumentException('Tên miền nguồn không hợp lệ.');
        }
        return explode('#', $url, 2)[0];
    }

    public static function resolve(string $base, string $location): string
    {
        if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $location)) {
            return self::validate($location);
        }
        if (str_starts_with($location, '//')) {
            return self::validate('https:' . $location);
        }
        $parts = parse_url($base);
        $origin = 'https://' . $parts['host'];
        if (str_starts_with($location, '?')) {
            return self::validate($origin . ($parts['path'] ?? '/') . $location);
        }
        if (str_starts_with($location, '#') || $location === '') {
            return self::validate($base);
        }
        $path = str_starts_with($location, '/') ? $location : preg_replace('~/[^/]*$~', '/', $parts['path'] ?? '/') . $location;
        $segments = [];
        foreach (explode('/', $path) as $segment) {
            if ($segment === '..') {
                array_pop($segments);
            } elseif ($segment !== '.' && $segment !== '') {
                $segments[] = $segment;
            }
        }
        return self::validate($origin . '/' . implode('/', $segments));
    }
}

/** Native curl_multi scheduler. The next handle is admitted only when a slot is free. */
final class CurlPool
{
    public function run(iterable $tasks, int $concurrency, callable $make, callable $done, callable $tick): bool
    {
        $concurrency = max(1, min(10000, $concurrency));
        $iterator = (static function () use ($tasks) { yield from $tasks; })();
        $iterator->rewind();
        $retries = new \SplQueue();
        $multi = curl_multi_init();
        curl_multi_setopt($multi, CURLMOPT_MAX_TOTAL_CONNECTIONS, $concurrency);
        curl_multi_setopt($multi, CURLMOPT_MAX_HOST_CONNECTIONS, $concurrency);
        $active = [];
        $peak = 0;
        $completed = 0;
        $enqueue = static function (mixed $extra) use ($retries): void {
            foreach (is_array($extra) ? $extra : [] as $task) {
                $retries->enqueue($task);
            }
        };
        try {
            while ($iterator->valid() || !$retries->isEmpty() || $active) {
                while (count($active) < $concurrency && ($iterator->valid() || !$retries->isEmpty())) {
                    if (!$retries->isEmpty()) {
                        $task = $retries->dequeue();
                    } else {
                        $task = $iterator->current();
                        $iterator->next();
                    }
                    try {
                        [$handle, $context] = $make($task);
                        $code = curl_multi_add_handle($multi, $handle);
                        if ($code !== CURLM_OK) {
                            throw new \RuntimeException('Không thêm được kết nối: ' . curl_multi_strerror($code));
                        }
                        $active[spl_object_id($handle)] = [$task, $handle, $context];
                        $peak = max($peak, count($active));
                    } catch (\Throwable $error) {
                        $enqueue($done($task, null, null, $error->getMessage()));
                        $completed++;
                    }
                }
                if (!$tick(['active' => count($active), 'peakActive' => $peak, 'completed' => $completed])) {
                    return false;
                }
                if (!$active) {
                    continue;
                }
                do {
                    $code = curl_multi_exec($multi, $running);
                } while ($code === CURLM_CALL_MULTI_PERFORM);
                if ($code !== CURLM_OK) {
                    throw new \RuntimeException(curl_multi_strerror($code));
                }
                while ($message = curl_multi_info_read($multi)) {
                    $handle = $message['handle'];
                    $id = spl_object_id($handle);
                    [$task, , $context] = $active[$id];
                    unset($active[$id]);
                    $error = $message['result'] === CURLE_OK ? null : (curl_error($handle) ?: curl_strerror($message['result']));
                    curl_multi_remove_handle($multi, $handle);
                    $enqueue($done($task, $context, $handle, $error));
                    $completed++;
                    unset($handle, $context, $message);
                }
                if ($active && curl_multi_select($multi, 0.025) === -1) {
                    usleep(1000);
                }
            }
            return $tick(['active' => 0, 'peakActive' => $peak, 'completed' => $completed]);
        } finally {
            foreach ($active as [, $handle]) {
                curl_multi_remove_handle($multi, $handle);
            }
            $active = [];
            curl_multi_close($multi);
        }
    }
}

final class Network implements NetworkDriver
{
    private array $dns = [];
    private readonly CurlPool $pool;

    public function __construct(private readonly array $config, private readonly bool $allowPrivateForTests = false)
    {
        $this->pool = new CurlPool();
    }

    private function addresses(string $host): array
    {
        $host = trim($host, '[]');
        if (isset($this->dns[$host])) {
            return $this->dns[$host];
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            $addresses = [$host];
        } else {
            $addresses = @gethostbynamel($host) ?: [];
            foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $record) {
                if (isset($record['ipv6'])) {
                    $addresses[] = $record['ipv6'];
                }
            }
        }
        if (!$addresses || (!$this->allowPrivateForTests && array_filter($addresses, static fn($ip) => !Parser::publicIP($ip)))) {
            throw new \RuntimeException('DNS không có IP công khai hoặc trỏ vào mạng riêng.');
        }
        return $this->dns[$host] = array_values(array_unique($addresses));
    }

    private function handle(string $url, object $context, int $maxBytes, int $timeoutMs): \CurlHandle
    {
        $handle = curl_init($url);
        $context->body = '';
        $context->headers = '';
        curl_setopt_array($handle, [
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_MAXREDIRS => 0, CURLOPT_RETURNTRANSFER => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT_MS => $timeoutMs, CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_NOSIGNAL => true, CURLOPT_PROXY => '', CURLOPT_NOPROXY => '',
            CURLOPT_USERAGENT => 'ProxyForge-PHP/1.0 (public-proxy-checker)', CURLOPT_ENCODING => '',
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1, CURLOPT_FORBID_REUSE => true,
            CURLOPT_HEADERFUNCTION => static function ($handle, $header) use ($context): int {
                if (strlen($context->headers) + strlen($header) > 16384) {
                    return 0;
                }
                $context->headers .= $header;
                return strlen($header);
            },
            CURLOPT_WRITEFUNCTION => static function ($handle, $body) use ($context, $maxBytes): int {
                if (strlen($context->body) + strlen($body) > $maxBytes) {
                    return 0;
                }
                $context->body .= $body;
                return strlen($body);
            },
        ]);
        if (!empty($this->config['ca_file'])) {
            curl_setopt($handle, CURLOPT_CAINFO, $this->config['ca_file']);
        }
        return $handle;
    }

    private function feedHandle(string $url, object $context, int $maxBytes, int $timeoutMs): \CurlHandle
    {
        if (!$this->allowPrivateForTests) {
            $url = Url::validate($url);
        }
        $parts = parse_url($url);
        $host = trim($parts['host'], '[]');
        $addresses = $this->addresses($host);
        $handle = $this->handle($url, $context, $maxBytes, $timeoutMs);
        if (!filter_var($host, FILTER_VALIDATE_IP)) {
            $pinned = array_map(static fn($ip) => str_contains($ip, ':') ? '[' . $ip . ']' : $ip, $addresses);
            curl_setopt($handle, CURLOPT_RESOLVE, [$host . ':' . ($parts['port'] ?? 443) . ':' . implode(',', $pinned)]);
        }
        return $handle;
    }

    public function collect(array $sources, callable $result, callable $tick): bool
    {
        $tasks = (static function () use ($sources) {
            foreach ($sources as $source) {
                if (empty($source['enabled'])) {
                    continue;
                }
                foreach ($source['feeds'] ?? [$source] as $feed) {
                    yield ['source' => $source, 'url' => $feed['url'], 'protocol' => $feed['protocol'] ?? $source['protocol'], 'redirects' => 0, 'started' => now()];
                }
            }
        })();
        return $this->pool->run($tasks, 16, function ($task) {
            $remaining = 12000 - (now() - $task['started']);
            if ($remaining <= 0) {
                throw new \RuntimeException('Nguồn quá thời gian 12 giây.');
            }
            $context = new \stdClass();
            return [$this->feedHandle($task['url'], $context, 4 * 1024 * 1024, $remaining), $context];
        }, function ($task, $context, $handle, $error) use ($result) {
            $status = $handle ? (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE) : 0;
            if (!$error && in_array($status, [301, 302, 303, 307, 308], true)) {
                try {
                    if ($task['redirects'] >= 3 || !preg_match('/^Location:\s*(.+?)\r?$/mi', $context->headers, $location)) {
                        throw new \RuntimeException('Nguồn chuyển hướng quá nhiều hoặc thiếu Location.');
                    }
                    $task['url'] = Url::resolve($task['url'], trim($location[1]));
                    $task['redirects']++;
                    return [$task];
                } catch (\Throwable $failure) {
                    $error = $failure->getMessage();
                }
            }
            if (!$error && $status !== 200) {
                $error = 'HTTP ' . $status;
            }
            $proxies = !$error ? Parser::parse($context->body, $task['protocol'], $this->config['max_proxies']) : [];
            $result($task['source']['id'], $proxies, $error, now() - $task['started']);
            return [];
        }, $tick);
    }

    public function check(array $proxies, int $concurrency, callable $result, callable $tick): bool
    {
        return $this->pool->run($proxies, $concurrency, function ($proxy) {
            if (!Parser::normalize($proxy['host'], $proxy['port'], $proxy['protocol'], $this->allowPrivateForTests)) {
                throw new \RuntimeException('Địa chỉ proxy không hợp lệ hoặc không công khai.');
            }
            $parts = parse_url($this->config['check_url']);
            if (!$parts || ($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass'])) {
                throw new \RuntimeException('Đích kiểm tra cần URL HTTPS không chứa tài khoản.');
            }
            $context = new \stdClass();
            $context->started = now();
            $handle = $this->handle($this->config['check_url'], $context, 65536, 3000);
            $type = match ($proxy['protocol']) {
                'http' => CURLPROXY_HTTP, 'https' => CURLPROXY_HTTPS,
                'socks4' => CURLPROXY_SOCKS4A, 'socks5' => CURLPROXY_SOCKS5_HOSTNAME,
            };
            $authority = (str_contains($proxy['host'], ':') ? '[' . $proxy['host'] . ']' : $proxy['host']) . ':' . $proxy['port'];
            curl_setopt_array($handle, [
                CURLOPT_PROXY => $authority, CURLOPT_PROXYTYPE => $type, CURLOPT_NOPROXY => '',
                CURLOPT_HTTPPROXYTUNNEL => true, CURLOPT_PROXY_SSL_VERIFYPEER => true, CURLOPT_PROXY_SSL_VERIFYHOST => 2,
                CURLOPT_FRESH_CONNECT => true, CURLOPT_ENCODING => 'identity', CURLOPT_HTTP_CONTENT_DECODING => false,
                CURLOPT_HTTPHEADER => ['Accept: text/plain, application/json', 'Connection: close'],
            ]);
            if (!empty($this->config['ca_file'])) {
                curl_setopt($handle, CURLOPT_PROXY_CAINFO, $this->config['ca_file']);
            }
            return [$handle, $context];
        }, static function ($proxy, $context, $handle, $error) use ($result) {
            $status = $handle ? (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE) : 0;
            $ip = null;
            if (!$error && $status === 200) {
                $body = trim($context->body);
                if (filter_var($body, FILTER_VALIDATE_IP)) {
                    $ip = $body;
                } else {
                    $json = json_decode($body, true);
                    $candidate = is_array($json) ? ($json['ip'] ?? $json['origin'] ?? '') : '';
                    if (is_string($candidate)) {
                        $candidate = trim(explode(',', $candidate)[0]);
                        if (filter_var($candidate, FILTER_VALIDATE_IP)) {
                            $ip = $candidate;
                        }
                    }
                }
            }
            $measurement = ['status' => $ip ? 'alive' : 'dead', 'checkedAt' => timestamp(),
                'latencyMs' => $context ? max(0, now() - $context->started) : 0,
                'error' => $ip ? null : substr($error ?: ($status !== 200 ? 'Đích kiểm tra trả HTTP ' . $status : 'Đích không trả địa chỉ IP.'), 0, 180)];
            if ($ip) {
                $measurement['exitIP'] = $ip;
            }
            $result($proxy, $measurement);
            return [];
        }, $tick);
    }

    public function download(string $url, string $destination, callable $tick): void
    {
        $file = @fopen($destination, 'wb');
        if (!$file) {
            throw new \RuntimeException('Không ghi được cơ sở dữ liệu IP.');
        }
        $failure = null;
        try {
            $finished = $this->pool->run([['url' => $url]], 1, function ($task) use ($file) {
                $context = new \stdClass();
                $context->bytes = 0;
                $handle = $this->feedHandle($task['url'], $context, 0, 20000);
                curl_setopt($handle, CURLOPT_WRITEFUNCTION, static function ($handle, $body) use ($context, $file) {
                    $context->bytes += strlen($body);
                    return $context->bytes <= 32 * 1024 * 1024 ? (fwrite($file, $body) ?: 0) : 0;
                });
                return [$handle, $context];
            }, static function ($task, $context, $handle, $error) use (&$failure) {
                $status = $handle ? (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE) : 0;
                $failure = $error ?: ($status === 200 ? null : 'IP database HTTP ' . $status);
                return [];
            }, $tick);
            if (!$finished || $failure) {
                throw new \RuntimeException($failure ?: 'Đã dừng tải dữ liệu IP.');
            }
        } finally {
            fclose($file);
        }
    }
}
