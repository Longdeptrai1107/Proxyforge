<?php
declare(strict_types=1);

namespace ProxyForge;

final class Store
{
    public const GUARD = "<?php http_response_code(404); exit; ?>\n";
    public readonly string $directory;

    public function __construct(public readonly array $config)
    {
        $this->directory = rtrim($config['data_dir'], '/\\');
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException('Không tạo được thư mục dữ liệu. Kiểm tra quyền ghi của PHP.');
        }
        $lock = $this->lock(LOCK_EX);
        try {
            if (!is_file($this->path())) {
                $sources = json_decode(file_get_contents(dirname(__DIR__) . '/resources/sources.json'), true, 512, JSON_THROW_ON_ERROR);
                $this->write([
                    'version' => 1, 'revision' => 0, 'sources' => $sources, 'proxies' => [], 'queue' => [], 'job' => null,
                    'auth' => ['passwordHash' => null, 'cronToken' => bin2hex(random_bytes(32)), 'attempts' => [], 'generation' => 0],
                    'automation' => ['enabled' => true, 'intervalMs' => 60000, 'nextRunAtMs' => now(),
                        'lastRunAtMs' => null, 'rounds' => 0, 'error' => null,
                        'options' => ['concurrency' => $config['concurrency'], 'limit' => $config['max_proxies'], 'timeoutMs' => 3000]],
                    'worker' => ['heartbeatAtMs' => null, 'mode' => null], 'stopGeneration' => 0, 'refreshRequested' => false,
                ]);
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function path(): string
    {
        return $this->directory . '/state.php';
    }

    private function lock(int $mode)
    {
        $lock = @fopen($this->directory . '/state.lock', 'c+');
        if (!$lock || !flock($lock, $mode)) {
            throw new \RuntimeException('Không khóa được kho dữ liệu.');
        }
        return $lock;
    }

    private function load(): array
    {
        $raw = @file_get_contents($this->path());
        if ($raw === false || !str_starts_with($raw, self::GUARD)) {
            throw new \RuntimeException('Kho dữ liệu không hợp lệ; giữ lại file để khôi phục.');
        }
        $state = json_decode(substr($raw, strlen(self::GUARD)), true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($state) || ($state['version'] ?? null) !== 1 || !isset($state['auth'], $state['automation'], $state['sources'])) {
            throw new \RuntimeException('Phiên dữ liệu không được hỗ trợ.');
        }
        return $state;
    }

    private function write(array $state): void
    {
        $temporary = $this->directory . '/.state-' . bin2hex(random_bytes(8)) . '.php';
        try {
            $body = self::GUARD . json_encode($state, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
            if (file_put_contents($temporary, $body) !== strlen($body)) {
                throw new \RuntimeException('Không lưu được phiên. Có thể hosting đã hết dung lượng.');
            }
            @chmod($temporary, 0600);
            $replaced = false;
            for ($attempt = 0; $attempt < 10; $attempt++) {
                if (@rename($temporary, $this->path())) {
                    $replaced = true;
                    break;
                }
                // Windows scanners or non-cooperating readers can briefly deny
                // replacement. Keep the old file intact and retry the rename.
                usleep(20000);
            }
            if (!$replaced) {
                throw new \RuntimeException('Không thay được file dữ liệu.');
            }
        } finally {
            if (is_file($temporary)) {
                @unlink($temporary);
            }
        }
    }

    public function read(): array
    {
        $lock = $this->lock(LOCK_SH);
        try {
            return $this->load();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public function update(callable $change): mixed
    {
        $lock = $this->lock(LOCK_EX);
        try {
            $state = $this->load();
            $result = $change($state);
            $state['revision']++;
            $this->write($state);
            return $result;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public function workerLock()
    {
        $lock = @fopen($this->directory . '/worker.lock', 'c+');
        if (!$lock) {
            throw new \RuntimeException('Không tạo được khóa worker.');
        }
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            return false;
        }
        return $lock;
    }
}
