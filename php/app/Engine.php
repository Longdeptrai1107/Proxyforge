<?php
declare(strict_types=1);

namespace ProxyForge;

final class Engine
{
    private readonly NetworkDriver $network;

    public function __construct(public readonly Store $store, ?NetworkDriver $network = null)
    {
        $this->network = $network ?? new Network($store->config);
    }

    public static function live(array $state): array
    {
        $live = [];
        foreach ($state['proxies'] ?? [] as $proxy) {
            if (($proxy['status'] ?? '') === 'alive' && Parser::normalize($proxy['host'] ?? '', $proxy['port'] ?? '', $proxy['protocol'] ?? '')) {
                $proxy['id'] = Parser::key($proxy);
                $live[$proxy['id']] = $proxy;
            }
        }
        return $live;
    }

    public function snapshot(): array
    {
        $state = $this->store->read();
        $live = self::live($state);
        $latencies = array_column(array_values($live), 'latencyMs');
        $sources = $state['sources'];
        $job = $state['job'];
        if ($job) {
            $elapsed = max(0, ($job['finishedAtMs'] ?? now()) - $job['startedAtMs']);
            $job['elapsedMs'] = $elapsed;
            $job['rate'] = $elapsed > 0 ? (int) round(($job['networkChecked'] ?? 0) * 1000 / $elapsed) : 0;
        }
        $heartbeat = $state['worker']['heartbeatAtMs'];
        return [
            'revision' => $state['revision'], 'job' => $job, 'automation' => $state['automation'],
            'worker' => $state['worker'] + ['online' => $heartbeat !== null && now() - $heartbeat < 130000],
            'counts' => ['total' => count($live), 'alive' => count($live)], 'queued' => count($state['queue']),
            'latencyMs' => $latencies ? (int) round(array_sum($latencies) / count($latencies)) : null,
            'sources' => ['total' => count($sources), 'enabled' => count(array_filter($sources, static fn($source) => !empty($source['enabled']))),
                'ok' => count(array_filter($sources, static fn($source) => ($source['status'] ?? '') === 'ok')),
                'failed' => count(array_filter($sources, static fn($source) => ($source['status'] ?? '') === 'error'))],
            'limits' => ['maxProxies' => $this->store->config['max_proxies'], 'maxConcurrency' => $this->store->config['concurrency'], 'timeoutMs' => 3000],
            'refreshRequested' => $state['refreshRequested'],
        ];
    }

    public function run(bool $force = false, string $mode = 'cron'): array
    {
        $lock = $this->store->workerLock();
        if (!$lock) {
            return ['state' => 'busy', 'message' => 'Lượt trước vẫn chạy.'];
        }
        $job = null;
        try {
            $state = $this->store->update(function (&$state) use ($mode) {
                // Owning the OS lock proves an unfinished job has lost its worker.
                if (($state['job']['state'] ?? '') === 'running') {
                    $state['job']['state'] = 'stopped';
                    $state['job']['active'] = 0;
                    $state['job']['finishedAtMs'] = now();
                    $state['stopGeneration']++;
                }
                $state['automation']['options']['concurrency'] = max(1, min($this->store->config['concurrency'], (int) $state['automation']['options']['concurrency']));
                $state['automation']['options']['limit'] = max(1, min($this->store->config['max_proxies'], (int) $state['automation']['options']['limit']));
                $state['worker'] = ['heartbeatAtMs' => now(), 'mode' => $mode];
                return $state;
            });
            $auto = $state['automation'];
            $requested = $force || $state['refreshRequested'];
            // Minute-based cron can arrive a few milliseconds before the previous
            // start time. Allow normal scheduler jitter without losing a whole minute.
            $jitter = str_starts_with($mode, 'cron') ? 1000 : 0;
            if (!$requested && (!$auto['enabled'] || ($auto['nextRunAtMs'] ?? 0) > now() + $jitter)) {
                return ['state' => $auto['enabled'] ? 'idle' : 'paused'];
            }
            $sources = $state['sources'];
            $live = self::live($state);
            $initialLive = array_fill_keys(array_keys($live), true);
            $inventory = $live;
            $generation = $state['stopGeneration'];
            $concurrency = min($this->store->config['concurrency'], max(1, (int) $auto['options']['concurrency']));
            $limit = min($this->store->config['max_proxies'], max(1, (int) $auto['options']['limit']));
            foreach ($state['queue'] as $candidate) {
                $this->merge($inventory, $candidate, 'manual', $limit);
            }
            $job = ['id' => bin2hex(random_bytes(16)), 'type' => 'refresh', 'state' => 'running', 'phase' => 'collect',
                'startedAtMs' => now(), 'total' => 0, 'completed' => 0, 'networkChecked' => 0, 'added' => 0,
                'liveAdded' => 0, 'removed' => 0, 'errors' => 0, 'active' => 0, 'peakActive' => 0, 'sourcesCompleted' => 0,
                'options' => ['concurrency' => $concurrency, 'timeoutMs' => 3000, 'limit' => $limit, 'mode' => 'https']];
            $this->store->update(static function (&$state) use ($job) {
                $state['job'] = $job;
                $state['refreshRequested'] = false;
                $state['automation']['lastRunAtMs'] = $job['startedAtMs'];
                $state['automation']['nextRunAtMs'] = null;
                $state['automation']['error'] = null;
            });
            $lastPublish = 0;
            $lastPoll = 0;
            $checked = [];
            $cancelled = false;
            $publish = function () use (&$live, &$sources, &$job, &$checked, &$lastPublish): void {
                $this->store->update(static function (&$state) use (&$live, &$sources, &$job, &$checked): void {
                    if (($state['job']['id'] ?? '') !== $job['id']) {
                        return;
                    }
                    $state['proxies'] = $live;
                    $state['sources'] = $sources;
                    $state['job'] = $job;
                    $state['worker']['heartbeatAtMs'] = now();
                    foreach ($checked as $key => $_) {
                        unset($state['queue'][$key]);
                    }
                });
                $checked = [];
                $lastPublish = now();
            };
            $tick = function (array $metrics = []) use (&$lastPublish, &$lastPoll, &$job, $generation, &$cancelled, $publish): bool {
                if (now() - $lastPoll >= 150) {
                    $cancelled = $this->store->read()['stopGeneration'] !== $generation;
                    $lastPoll = now();
                }
                if ($job['phase'] === 'check') {
                    $job['active'] = $metrics['active'] ?? $job['active'];
                    $job['peakActive'] = max($job['peakActive'], $metrics['peakActive'] ?? 0);
                }
                if (now() - $lastPublish >= 250) {
                    $publish();
                }
                return !$cancelled;
            };
            $sourceResults = [];
            try {
                $finished = $this->network->collect($sources, function ($sourceId, $proxies, $error, $duration) use (&$inventory, &$sources, &$job, &$sourceResults, $limit): void {
                    $sourceResults[$sourceId] ??= ['ok' => 0, 'errors' => [], 'count' => 0, 'durationMs' => 0];
                    $summary = &$sourceResults[$sourceId];
                    $summary['durationMs'] += $duration;
                    if ($error) {
                        $summary['errors'][] = substr($error, 0, 180);
                    } else {
                        $summary['ok']++;
                        $summary['count'] += count($proxies);
                        foreach ($proxies as $candidate) {
                            if ($this->merge($inventory, $candidate, $sourceId, $limit)) {
                                $job['added']++;
                            }
                        }
                    }
                    foreach ($sources as &$source) {
                        if ($source['id'] === $sourceId) {
                            $source['status'] = $summary['ok'] ? 'ok' : 'error';
                            $source['count'] = $summary['count'];
                            $source['durationMs'] = $summary['durationMs'];
                            $source['error'] = $summary['ok'] ? null : ($summary['errors'][0] ?? null);
                            $source['feedErrors'] = $summary['errors'];
                            $source['lastFetchedAt'] = timestamp();
                            break;
                        }
                    }
                    unset($source);
                    $job['sourcesCompleted']++;
                }, $tick);
                if ($finished && $tick()) {
                    $job['phase'] = 'check';
                    $job['total'] = count($inventory);
                    $publish();
                    $finished = $this->network->check($inventory, $concurrency, static function ($proxy, $measurement) use (&$live, &$job, &$checked, $initialLive): void {
                        $key = Parser::key($proxy);
                        $job['completed']++;
                        $job['networkChecked']++;
                        $checked[$key] = true;
                        if ($measurement['status'] === 'alive') {
                            $live[$key] = array_replace($live[$key] ?? [], $proxy, $measurement, ['id' => $key]);
                            if (!isset($initialLive[$key])) {
                                $job['liveAdded']++;
                            }
                        } else {
                            $job['errors']++;
                            if (isset($live[$key])) {
                                unset($live[$key]);
                                $job['removed']++;
                            }
                        }
                    }, $tick);
                }
                if ($finished && $tick() && $this->store->config['enrich_geo'] && $this->network instanceof Network && $live) {
                    $job['phase'] = 'location';
                    $job['active'] = 0;
                    $publish();
                    [$live, $warning] = (new Geo($this->store, $this->network))->enrich($live, $tick);
                    if ($warning) {
                        $job['geoWarning'] = $warning;
                    }
                }
                $job['state'] = $finished && $tick() ? 'done' : 'stopped';
            } catch (\Throwable $error) {
                $job['state'] = 'error';
                $job['error'] = substr($error->getMessage(), 0, 240);
            }
            $job['active'] = 0;
            $job['finishedAtMs'] = now();
            $publish();
            $this->store->update(static function (&$state) use ($job): void {
                if ($job['state'] === 'done') {
                    $state['automation']['rounds']++;
                }
                $state['automation']['error'] = $job['error'] ?? null;
                $state['automation']['nextRunAtMs'] = $state['automation']['enabled'] ? max(now(), $job['startedAtMs'] + 60000) : null;
            });
            return ['state' => $job['state'], 'job' => $job, 'live' => count($live)];
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function merge(array &$inventory, array $candidate, string $source, int $limit): bool
    {
        $normalized = Parser::normalize($candidate['host'] ?? '', $candidate['port'] ?? '', $candidate['protocol'] ?? '');
        if (!$normalized) {
            return false;
        }
        $key = Parser::key($normalized);
        $existing = $inventory[$key] ?? null;
        if (!$existing && count($inventory) >= $limit) {
            return false;
        }
        $candidate['sources'] = array_values(array_unique(array_merge($existing['sources'] ?? [], $candidate['sources'] ?? [], [$source])));
        $inventory[$key] = array_replace($existing ?? [], $candidate, $normalized, ['id' => $key]);
        return $existing === null;
    }

    public function auto(bool $enabled, ?int $concurrency = null, ?int $limit = null): void
    {
        if (!$enabled) {
            $this->stop();
            return;
        }
        $this->store->update(function (&$state) use ($concurrency, $limit) {
            $state['automation']['enabled'] = true;
            $state['automation']['nextRunAtMs'] = now();
            $state['refreshRequested'] = true;
            if ($concurrency !== null) {
                $state['automation']['options']['concurrency'] = max(1, min($this->store->config['concurrency'], $concurrency));
            }
            if ($limit !== null) {
                $state['automation']['options']['limit'] = max(1, min($this->store->config['max_proxies'], $limit));
            }
        });
    }

    public function stop(): void
    {
        $this->store->update(static function (&$state): void {
            $state['automation']['enabled'] = false;
            $state['automation']['nextRunAtMs'] = null;
            $state['refreshRequested'] = false;
            $state['stopGeneration']++;
        });
    }

    public function requestRefresh(): void
    {
        $this->store->update(static function (&$state): void { $state['refreshRequested'] = true; });
    }

    private static function requireIdle(array $state): void
    {
        if (($state['job']['state'] ?? '') === 'running' && now() - ($state['worker']['heartbeatAtMs'] ?? 0) < 30000) {
            throw new \RuntimeException('Hãy tạm dừng và đợi lượt hiện tại kết thúc.');
        }
    }

    public function import(string $text, string $protocol): int
    {
        $proxies = Parser::parse($text, $protocol, $this->store->config['max_proxies']);
        return $this->store->update(function (&$state) use ($proxies) {
            self::requireIdle($state);
            $added = 0;
            foreach ($proxies as $proxy) {
                if ($this->merge($state['queue'], $proxy, 'manual', $this->store->config['max_proxies'])) {
                    $added++;
                }
            }
            if ($state['queue']) {
                $state['refreshRequested'] = true;
            }
            return $added;
        });
    }

    public function toggleSources(array $ids, bool $enabled): void
    {
        $this->store->update(static function (&$state) use ($ids, $enabled): void {
            self::requireIdle($state);
            foreach ($state['sources'] as &$source) {
                if (in_array($source['id'], $ids, true)) {
                    $source['enabled'] = $enabled;
                }
            }
        });
    }

    public function addSource(string $url, string $name, string $protocol): void
    {
        $url = Url::validate($url);
        if (!in_array($protocol, Parser::PROTOCOLS, true)) {
            throw new \InvalidArgumentException('Giao thức không hợp lệ.');
        }
        $this->store->update(static function (&$state) use ($url, $name, $protocol): void {
            self::requireIdle($state);
            if (count($state['sources']) >= 500 || in_array($url, array_column($state['sources'], 'url'), true)) {
                throw new \InvalidArgumentException('Nguồn đã tồn tại hoặc đã đạt giới hạn 500 nguồn.');
            }
            $host = parse_url($url, PHP_URL_HOST);
            $state['sources'][] = ['id' => 'custom-' . bin2hex(random_bytes(8)), 'url' => $url,
                'name' => substr(trim($name) ?: $host, 0, 120), 'publisher' => $host, 'protocol' => $protocol, 'enabled' => true, 'custom' => true];
        });
    }

    public function clear(): void
    {
        $this->store->update(static function (&$state): void {
            self::requireIdle($state);
            $state['proxies'] = [];
            $state['queue'] = [];
        });
    }

    public function filtered(array $query): array
    {
        $rows = array_values(self::live($this->store->read()));
        $search = strtolower(substr((string) ($query['search'] ?? ''), 0, 160));
        $protocol = $query['protocol'] ?? 'all';
        $country = strtoupper((string) ($query['country'] ?? 'ALL'));
        $status = $query['status'] ?? 'alive';
        $rows = array_values(array_filter($rows, static function ($proxy) use ($search, $protocol, $country, $status) {
            return in_array($status, ['all', 'alive'], true) && ($protocol === 'all' || $proxy['protocol'] === $protocol)
                && ($country === 'ALL' || ($proxy['countryCode'] ?? 'UNKNOWN') === $country)
                && ($search === '' || str_contains(strtolower(implode(' ', array_filter([
                    $proxy['id'], $proxy['server'] ?? '', $proxy['countryCode'] ?? '', $proxy['country'] ?? '', $proxy['city'] ?? '', $proxy['asn'] ?? '',
                ]))), $search));
        }));
        usort($rows, static fn($a, $b) => (($a['latencyMs'] ?? PHP_INT_MAX) <=> ($b['latencyMs'] ?? PHP_INT_MAX)) ?: strcmp($a['id'], $b['id']));
        return $rows;
    }

    public function list(array $query): array
    {
        $rows = $this->filtered($query);
        $size = max(1, min(500, (int) ($query['pageSize'] ?? 50)));
        $pages = max(1, (int) ceil(count($rows) / $size));
        $page = max(1, min($pages, (int) ($query['page'] ?? 1)));
        return ['rows' => array_slice($rows, ($page - 1) * $size, $size), 'total' => count($rows), 'page' => $page, 'pages' => $pages, 'pageSize' => $size];
    }
}
