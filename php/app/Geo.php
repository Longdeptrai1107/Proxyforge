<?php
declare(strict_types=1);

namespace ProxyForge;

/** Stream public range files; keep only metadata for the current live IPs in memory. */
final class Geo
{
    public function __construct(private readonly Store $store, private readonly Network $network)
    {
    }

    private function rows(string $path, string $kind, callable $tick): \Generator
    {
        $file = @gzopen($path, 'rb');
        if (!$file) {
            throw new \RuntimeException('Không mở được dữ liệu IP.');
        }
        $last = null;
        $count = 0;
        try {
            while (($line = gzgets($file, 8192)) !== false) {
                if (++$count % 2048 === 0 && !$tick([])) {
                    throw new \RuntimeException('Đã dừng bổ sung địa lý.');
                }
                if (gztell($file) > 256 * 1024 * 1024 || $count > 3000000) {
                    throw new \RuntimeException('Dữ liệu IP vượt giới hạn giải nén.');
                }
                $columns = $kind === 'country' ? str_getcsv(trim($line), ',', '"', '') : explode("\t", rtrim($line, "\r\n"), 5);
                if (count($columns) !== ($kind === 'country' ? 3 : 5)) {
                    throw new \RuntimeException('Dòng dữ liệu IP không hợp lệ.');
                }
                [$start, $end] = $columns;
                if ($kind === 'asn4') {
                    if (!ctype_digit($start) || !ctype_digit($end) || (int) $end > 4294967295) {
                        throw new \RuntimeException('Dải ASN IPv4 không hợp lệ.');
                    }
                    $start = pack('N', (int) $start);
                    $end = pack('N', (int) $end);
                } else {
                    $start = @inet_pton($start);
                    $end = @inet_pton($end);
                }
                if (!$start || !$end || strlen($start) !== strlen($end) || strcmp($start, $end) > 0) {
                    throw new \RuntimeException('Biên dữ liệu IP không hợp lệ.');
                }
                $family = strlen($start);
                if ($last !== null && strlen($last) === $family && strcmp($start, $last) <= 0) {
                    throw new \RuntimeException('Các dải IP không theo thứ tự.');
                }
                $last = $end;
                yield [$start, $end, $columns];
            }
            if (!$count || !gzeof($file)) {
                throw new \RuntimeException('Dữ liệu IP rỗng hoặc bị cắt.');
            }
        } finally {
            gzclose($file);
        }
    }

    private function cached(string $name, string $url, string $kind, int $age, callable $tick): string
    {
        $path = $this->store->directory . '/' . $name;
        if (!is_file($path) || time() - filemtime($path) > $age) {
            $temporary = $path . '.download';
            try {
                $this->network->download($url, $temporary, $tick);
                foreach ($this->rows($temporary, $kind, $tick) as $row) {
                    // Validate the complete download before replacing the old cache.
                }
                if (!@rename($temporary, $path)) {
                    throw new \RuntimeException('Không thay được cache địa lý.');
                }
            } catch (\Throwable $error) {
                if (!is_file($path)) {
                    throw $error;
                }
            } finally {
                if (is_file($temporary)) {
                    @unlink($temporary);
                }
            }
        }
        return $path;
    }

    public function enrich(array $proxies, callable $tick): array
    {
        if (!$proxies || !function_exists('gzopen')) {
            return [$proxies, $proxies ? 'Hosting chưa bật zlib; giữ metadata từ nguồn.' : null];
        }
        $targets = [];
        foreach ($proxies as $key => $proxy) {
            $packed = inet_pton($proxy['host']);
            $targets[strlen($packed)][$proxy['host']] = $packed;
        }
        foreach ($targets as &$family) {
            asort($family, SORT_STRING);
        }
        unset($family);
        $metadata = [];
        $warnings = [];
        $datasets = [];
        foreach ([4 => ['asn4', 'ip2asn-v4-u32.tsv.gz'], 16 => ['asn6', 'ip2asn-v6.tsv.gz']] as $bytes => [$kind, $name]) {
            if (isset($targets[$bytes])) {
                $datasets[] = [$name, 'https://iptoasn.com/data/' . $name, $kind, 7 * 86400];
            }
        }
        $country = 'dbip-country-lite-' . gmdate('Y-m') . '.csv.gz';
        $datasets[] = [$country, 'https://download.db-ip.com/free/' . $country, 'country', 32 * 86400];
        foreach ($datasets as [$name, $url, $kind, $age]) {
            if (!$tick([])) {
                break;
            }
            try {
                $path = $this->cached($name, $url, $kind, $age, $tick);
                $indices = [4 => 0, 16 => 0];
                $families = [];
                foreach ($targets as $bytes => $family) {
                    $families[$bytes] = array_keys($family);
                }
                foreach ($this->rows($path, $kind, $tick) as [$start, $end, $columns]) {
                    $bytes = strlen($start);
                    $hosts = $families[$bytes] ?? [];
                    while (isset($hosts[$indices[$bytes]]) && strcmp($targets[$bytes][$hosts[$indices[$bytes]]], $start) < 0) {
                        $indices[$bytes]++;
                    }
                    while (isset($hosts[$indices[$bytes]]) && strcmp($targets[$bytes][$hosts[$indices[$bytes]]], $end) <= 0) {
                        $host = $hosts[$indices[$bytes]++];
                        if ($kind === 'country') {
                            if (preg_match('/^[A-Z]{2}$/D', $columns[2]) && !in_array($columns[2], ['ZZ', 'XX'], true)) {
                                $metadata[$host]['countryCode'] = $columns[2];
                                $metadata[$host]['locationSource'] = 'DB-IP Lite';
                            }
                        } else {
                            $metadata[$host]['asn'] = (int) $columns[2] ?: null;
                            $metadata[$host]['server'] = (int) $columns[2] ? substr($columns[4], 0, 160) : null;
                            if (!empty($columns[3]) && $columns[3] !== 'ZZ') {
                                $metadata[$host]['countryCode'] = $columns[3];
                                $metadata[$host]['locationSource'] = 'IPtoASN (ASN registration)';
                            }
                        }
                    }
                }
            } catch (\Throwable $error) {
                $warnings[] = $error->getMessage();
            }
        }
        foreach ($proxies as &$proxy) {
            foreach ($metadata[$proxy['host']] ?? [] as $field => $value) {
                if (empty($proxy[$field]) || ($field === 'countryCode' && ($metadata[$proxy['host']]['locationSource'] ?? '') === 'DB-IP Lite')) {
                    $proxy[$field] = $value;
                }
            }
            if (isset($metadata[$proxy['host']])) {
                $proxy['locationApproximate'] = true;
                $proxy['locationSource'] = $metadata[$proxy['host']]['locationSource'] ?? $proxy['locationSource'] ?? 'feed';
            }
        }
        unset($proxy);
        return [$proxies, $warnings ? implode('; ', array_unique($warnings)) : null];
    }
}
