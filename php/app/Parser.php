<?php
declare(strict_types=1);

namespace ProxyForge;

final class Parser
{
    public const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];
    private const ADDRESS = '~(?:(https?|socks[45])://)?(?:([^\s<>"\'@]+)@)?(\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?!\d)~i';

    public static function publicIP(string $host): bool
    {
        if (!filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_GLOBAL_RANGE)) {
            return false;
        }
        $packed = inet_pton($host);
        if (strlen($packed) === 4) {
            return ord($packed[0]) < 224;
        }
        // Do not accept multicast, mapped IPv4, 6to4 or Teredo endpoints.
        return ord($packed[0]) !== 255 && !str_starts_with($packed, hex2bin('00000000000000000000ffff'))
            && !str_starts_with($packed, hex2bin('2002')) && !str_starts_with($packed, hex2bin('20010000'));
    }

    public static function key(array $proxy): string
    {
        return $proxy['protocol'] . '://' . (str_contains($proxy['host'], ':') ? '[' . $proxy['host'] . ']' : $proxy['host']) . ':' . $proxy['port'];
    }

    public static function normalize(mixed $host, mixed $port, mixed $protocol, bool $allowPrivate = false): ?array
    {
        if (!is_scalar($host) || !is_scalar($port) || !is_string($protocol)) {
            return null;
        }
        $host = trim((string) $host, '[] ');
        $protocol = strtolower($protocol);
        if (!filter_var($host, FILTER_VALIDATE_IP) || !ctype_digit((string) $port) || (int) $port < 1 || (int) $port > 65535
            || !in_array($protocol, self::PROTOCOLS, true) || (!$allowPrivate && !self::publicIP($host))) {
            return null;
        }
        return ['host' => inet_ntop(inet_pton($host)), 'port' => (int) $port, 'protocol' => $protocol];
    }

    private static function metadata(array $row): array
    {
        $details = $row['ip_data'] ?? $row['connection'] ?? $row;
        $details = is_array($details) ? $details : $row;
        $result = [];
        $code = $row['country_code'] ?? $row['countryCode'] ?? $row['cc'] ?? $details['countryCode'] ?? $row['country'] ?? null;
        if (is_string($code) && preg_match('/^[a-z]{2}$/iD', $code)) {
            $result['countryCode'] = strtoupper($code);
        }
        $fields = [
            'country' => $row['countryName'] ?? $row['country_name'] ?? $details['country'] ?? null,
            'city' => $row['city'] ?? $details['city'] ?? null,
            'region' => $row['region'] ?? $details['regionName'] ?? null,
            'server' => $row['asn_org'] ?? $row['server'] ?? $row['isp'] ?? $details['isp'] ?? $details['org'] ?? null,
        ];
        foreach ($fields as $key => $value) {
            if (is_string($value) && trim($value) !== '') {
                $result[$key] = substr(trim($value), 0, 160);
            }
        }
        $asn = $row['asn'] ?? $details['asn'] ?? $details['as'] ?? null;
        if (is_scalar($asn) && preg_match('/^(?:AS)?(\d+)\b/i', (string) $asn, $match)) {
            $result['asn'] = (int) $match[1];
        }
        return $result ? $result + ['locationSource' => 'feed', 'locationApproximate' => true] : [];
    }

    private static function arithmetic(string $expression): ?int
    {
        if (!preg_match('/^\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/D', $expression, $parts)) {
            return null;
        }
        return (int) $parts[1] + (($parts[2] ?? '') === '+' ? (int) $parts[3] : (($parts[2] ?? '') === '-' ? -(int) $parts[3] : 0));
    }

    private static function decode(string $text): string
    {
        $text = preg_replace_callback('~\bProxy\s*\(\s*(["\'])([A-Za-z0-9+/=_-]{8,128})\1\s*\)~i', static fn($m) => base64_decode($m[2], true) ?: $m[0], $text);
        $text = preg_replace_callback('~document\.write\s*\(\s*atob\(\s*(["\'])([A-Za-z0-9+/=_-]{4,128})\1\s*\)\s*\)~i', static fn($m) => base64_decode($m[2], true) ?: $m[0], $text);
        $text = preg_replace_callback('~atob\(\s*(["\'])([A-Za-z0-9+/=_-]{4,128})\1\s*\)~i', static function ($m) {
            $decoded = base64_decode($m[2], true);
            return $decoded !== false && strlen($decoded) <= 2048 ? json_encode($decoded, JSON_INVALID_UTF8_SUBSTITUTE) : $m[0];
        }, $text);
        $text = preg_replace_callback('~(["\'])([^"\']{1,64})\1\.split\(["\']{2}\)\.reverse\(\)\.join\(["\']{2}\)~', static fn($m) => json_encode(strrev($m[2])), $text);
        $text = preg_replace_callback('~(["\'])([^"\']{1,64})\1\.repeat\((\d{1,2})\)~', static fn($m) => (int) $m[3] <= 16 ? json_encode(str_repeat($m[2], (int) $m[3])) : $m[0], $text);
        $text = preg_replace_callback('~\[([\d,\s]{1,512})\]\.map\(\(\s*\w+\s*\)\s*=>\s*String\.fromCharCode\(\s*\w+\s*([+-])\s*(\d+)\s*\)\s*\)\.join\(["\']{2}\)~', static function ($m) {
            preg_match_all('/\d+/', $m[1], $numbers);
            if (count($numbers[0]) > 128) {
                return $m[0];
            }
            $value = '';
            foreach ($numbers[0] as $number) {
                $code = (int) $number + ($m[2] === '+' ? (int) $m[3] : -(int) $m[3]);
                if ($code < 0 || $code > 127) {
                    return $m[0];
                }
                $value .= chr($code);
            }
            return json_encode($value);
        }, $text);
        for ($pass = 0; $pass < 8; $pass++) {
            $previous = $text;
            $text = preg_replace_callback('~(["\'])([^"\']{1,128})\1\.substring\(\s*([^,()]{1,16})(?:,\s*([^,()]{1,16}))?\s*\)~', static function ($m) {
                $start = self::arithmetic($m[3]);
                $end = isset($m[4]) ? self::arithmetic($m[4]) : strlen($m[2]);
                if ($start === null || $end === null || $start > 512 || $end > 512) {
                    return $m[0];
                }
                $start = min(strlen($m[2]), max(0, $start));
                $end = min(strlen($m[2]), max(0, $end));
                return json_encode(substr($m[2], min($start, $end), abs($end - $start)));
            }, $text);
            $text = preg_replace_callback('~(["\'])([^"\']{1,128})\1\.concat\(\s*(["\'])([^"\']{1,128})\3\s*\)~', static fn($m) => json_encode($m[2] . $m[4]), $text);
            if ($text === $previous) {
                break;
            }
        }
        return html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    private static function csv(string $text, string $default, callable $add): bool
    {
        $text = str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text;
        $firstLine = strtok($text, "\r\n") ?: '';
        $aliases = ['ip' => 'host', 'ipaddress' => 'host', 'address' => 'host', 'proxyport' => 'port',
            'scheme' => 'protocol', 'type' => 'protocol', 'proxytype' => 'protocol', 'countrycode' => 'countryCode',
            'cc' => 'countryCode', 'countryname' => 'countryName', 'asnorg' => 'server', 'isp' => 'server',
            'organization' => 'server', 'org' => 'server', 'as' => 'asn', 'user' => 'username', 'pass' => 'password'];
        foreach ([',', ';', "\t"] as $delimiter) {
            $headers = array_map(static function ($name) use ($aliases) {
                $name = preg_replace('/[^a-z0-9]/', '', strtolower(trim($name)));
                return $aliases[$name] ?? $name;
            }, str_getcsv($firstLine, $delimiter, '"', ''));
            if (!in_array('host', $headers, true) || !in_array('port', $headers, true)) {
                continue;
            }
            $stream = fopen('php://temp', 'w+b');
            try {
                fwrite($stream, $text);
                rewind($stream);
                fgetcsv($stream, 0, $delimiter, '"', '');
                $visited = 0;
                while (($values = fgetcsv($stream, 0, $delimiter, '"', '')) !== false && ++$visited < 400000) {
                    if (count($values) !== count($headers)) {
                        continue;
                    }
                    $row = array_combine($headers, $values);
                    if (empty($row['username']) && empty($row['password'])) {
                        $add($row['host'], $row['port'], $row['protocol'] ?? $default, $row);
                    }
                }
            } finally {
                fclose($stream);
            }
            return true;
        }
        return false;
    }

    public static function parse(string $text, string $default = 'http', int $limit = 100000, bool $allowPrivate = false): array
    {
        if (!in_array($default, self::PROTOCOLS, true)) {
            throw new \InvalidArgumentException('Giao thức không hợp lệ.');
        }
        $found = [];
        $add = static function ($host, $port, $protocol, array $metadata = []) use (&$found, $limit, $allowPrivate): void {
            $proxy = self::normalize($host, $port, $protocol, $allowPrivate);
            if (!$proxy) {
                return;
            }
            $key = self::key($proxy);
            if (isset($found[$key]) || count($found) < $limit) {
                $found[$key] = array_replace($found[$key] ?? [], $proxy, self::metadata($metadata));
            }
        };
        $scan = static function (string $value, array $protocols) use ($add): void {
            preg_match_all(self::ADDRESS, $value, $matches, PREG_SET_ORDER);
            foreach ($matches as $match) {
                if (($match[2] ?? '') === '') {
                    foreach ($protocols as $protocol) {
                        $add($match[3], $match[4], ($match[1] ?? '') ?: $protocol);
                    }
                }
            }
        };
        $isJson = false;
        $decoded = json_decode($text, true);
        if (is_array($decoded)) {
            $isJson = true;
            $stack = [$decoded];
            $visits = 0;
            while ($stack && count($found) < $limit && ++$visits < 400000) {
                $value = array_pop($stack);
                if (is_string($value)) {
                    $scan($value, [$default]);
                    continue;
                }
                if (!is_array($value)) {
                    continue;
                }
                $host = $value['ip'] ?? $value['host'] ?? $value['ipAddress'] ?? $value['ip_address'] ?? $value['addr'] ?? null;
                $port = $value['port'] ?? null;
                if ($host && $port && empty($value['username']) && empty($value['password'])) {
                    $protocols = $value['protocols'] ?? [$value['protocol'] ?? $value['proxy_type'] ?? $value['scheme'] ?? $value['type'] ?? $default];
                    foreach (is_array($protocols) ? $protocols : [$protocols] as $protocol) {
                        $add($host, $port, $protocol, $value);
                    }
                }
                foreach (array_reverse($value) as $child) {
                    if (is_array($child) || (!$host && is_string($child))) {
                        $stack[] = $child;
                    }
                }
            }
        }
        if (!$isJson && self::csv($text, $default, $add)) {
            return array_values($found);
        }
        $text = self::decode($text);
        $assignments = [];
        preg_match_all('~\b([a-z_]\w*)\s*=\s*(\d+)\s*(?:\^\s*([a-z_]\w*))?\s*;~i', $text, $definitions, PREG_SET_ORDER);
        for ($pass = 0; $pass < count($definitions); $pass++) {
            $changed = false;
            foreach ($definitions as $definition) {
                $name = strtolower($definition[1]);
                $other = strtolower($definition[3] ?? '');
                if ($other !== '' && !isset($assignments[$other])) {
                    continue;
                }
                $number = (int) $definition[2] ^ ($other !== '' ? $assignments[$other] : 0);
                if (($assignments[$name] ?? null) !== $number) {
                    $assignments[$name] = $number;
                    $changed = true;
                }
            }
            if (!$changed) {
                break;
            }
        }
        if (!$isJson) {
            $plain = preg_replace('~<(tr|pre|code)\b[^>]*>.*?</\1>~is', '', $text);
            $plain = preg_replace_callback('~<script\b[^>]*>(.*?)</script>~is', static function ($m) {
                return preg_match(self::ADDRESS, trim($m[1]), $address) && $address[0] === trim($m[1]) ? $m[1] : '';
            }, $plain);
            $scan($plain, [$default]);
        }
        preg_match_all('~<tr\b[^>]*>.*?</tr>~is', $text, $rows);
        foreach ($rows[0] as $row) {
            if (count($found) >= $limit) {
                break;
            }
            $protocols = [];
            $label = preg_replace('~<[^>]*>~', ' ', $row);
            if (preg_match('~data-protos\s*=\s*(["\'])(.*?)\1~is', $row, $advertised)) {
                $label = $advertised[2];
            }
            foreach (self::PROTOCOLS as $protocol) {
                if (preg_match('~\b' . $protocol . '\b~i', $label)) {
                    $protocols[] = $protocol;
                }
            }
            $protocols = $protocols ?: [$default];
            preg_match_all('~\bdata-p\s*=\s*(["\'])([A-Za-z0-9+/=_-]{12,128})\1~i', $row, $encoded, PREG_SET_ORDER);
            foreach ($encoded as $value) {
                $decoded = base64_decode($value[2], true);
                if ($decoded !== false) {
                    $scan(strrev($decoded), $protocols);
                }
            }
            preg_match_all('~<td\b[^>]*>(.*?)</td>~is', $row, $markup);
            $cells = array_map(static fn($cell) => trim(html_entity_decode(strip_tags($cell), ENT_QUOTES | ENT_HTML5, 'UTF-8')), $markup[1]);
            if (isset($cells[0]) && preg_match('~(?:\d{1,3}\.){3}\d{1,3}~', $cells[0], $ip) && $assignments) {
                preg_match_all('~\(([a-z_]\w*)\s*\^\s*([a-z_]\w*)\)~i', $markup[1][0], $xors, PREG_SET_ORDER);
                $port = '';
                foreach ($xors as $pair) {
                    if (isset($assignments[strtolower($pair[1])], $assignments[strtolower($pair[2])])) {
                        $port .= (string) ($assignments[strtolower($pair[1])] ^ $assignments[strtolower($pair[2])]);
                    }
                }
                foreach ($protocols as $protocol) {
                    $add($ip[0], $port, $protocol);
                }
            }
            foreach ($cells as $index => $cell) {
                $scan($cell, $protocols);
                if (isset($cells[$index + 1]) && ctype_digit($cells[$index + 1])) {
                    preg_match('~(?:\d{1,3}\.){3}\d{1,3}~', $cell, $ip);
                    foreach ($protocols as $protocol) {
                        $add($ip[0] ?? $cell, $cells[$index + 1], $protocol);
                    }
                }
            }
        }
        return array_values($found);
    }
}
