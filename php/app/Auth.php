<?php
declare(strict_types=1);

namespace ProxyForge;

final class Auth
{
    public readonly string $csrf;
    public readonly bool $authenticated;
    public readonly bool $needsSetup;

    public function __construct(private readonly Store $store)
    {
        self::headers();
        $this->session();
        $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
        $this->csrf = $_SESSION['csrf'];
        $auth = $store->read()['auth'];
        $this->needsSetup = empty($auth['passwordHash']);
        $this->authenticated = !$this->needsSetup && !empty($_SESSION['authenticated'])
            && ($_SESSION['generation'] ?? -1) === $auth['generation'];
        session_write_close();
    }

    public static function headers(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        header('X-Frame-Options: DENY');
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        header('Cache-Control: no-store');
    }

    private function session(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        $path = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/index.php'));
        session_name('pf_' . substr(hash('sha256', dirname(__DIR__)), 0, 16));
        session_start(['use_strict_mode' => true, 'cookie_httponly' => true, 'cookie_samesite' => 'Strict',
            'cookie_secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off', 'cookie_path' => rtrim($path, '/') . '/']);
    }

    public function requireLogin(): void
    {
        if (!$this->authenticated) {
            throw new \UnexpectedValueException('Vui lòng đăng nhập vào bảng quản trị.', 401);
        }
    }

    public function verifyCsrf(?string $token): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        $originHost = $origin ? parse_url($origin, PHP_URL_HOST) : null;
        $originPort = $origin ? parse_url($origin, PHP_URL_PORT) : null;
        $authority = $originHost ? $originHost . ($originPort ? ':' . $originPort : '') : null;
        if (!$token || !hash_equals($this->csrf, $token) || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site'
            || ($origin && strcasecmp($authority ?? '', $_SERVER['HTTP_HOST'] ?? '') !== 0)) {
            throw new \UnexpectedValueException('Phiên không hợp lệ. Hãy tải lại trang.', 403);
        }
    }

    public function setup(string $password): void
    {
        if (strlen($password) < 12 || strlen($password) > 72) {
            throw new \InvalidArgumentException('Mật khẩu cần từ 12 đến 72 byte.');
        }
        $this->store->update(static function (&$state) use ($password): void {
            if (!empty($state['auth']['passwordHash'])) {
                throw new \RuntimeException('Website đã được thiết lập. Hãy đăng nhập.');
            }
            $state['auth']['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
            $state['auth']['generation']++;
        });
        $this->login($password);
    }

    public function login(string $password): void
    {
        $key = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown');
        $result = $this->store->update(static function (&$state) use ($password, $key) {
            $attempt = $state['auth']['attempts'][$key] ?? ['started' => time(), 'count' => 0];
            if (time() - $attempt['started'] >= 600) {
                $attempt = ['started' => time(), 'count' => 0];
            }
            if ($attempt['count'] >= 8) {
                return ['error' => 'Đã thử quá nhiều lần. Thử lại sau 10 phút.'];
            }
            if (empty($state['auth']['passwordHash']) || strlen($password) > 72 || !password_verify($password, $state['auth']['passwordHash'])) {
                $attempt['count']++;
                $state['auth']['attempts'][$key] = $attempt;
                $state['auth']['attempts'] = array_slice($state['auth']['attempts'], -200, null, true);
                return ['error' => 'Mật khẩu không đúng.'];
            }
            unset($state['auth']['attempts'][$key]);
            return ['generation' => $state['auth']['generation']];
        });
        if (isset($result['error'])) {
            throw new \UnexpectedValueException($result['error'], 403);
        }
        $this->session();
        session_regenerate_id(true);
        $_SESSION['authenticated'] = true;
        $_SESSION['generation'] = $result['generation'];
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        session_write_close();
    }

    public function logout(): void
    {
        $this->session();
        $_SESSION = [];
        session_regenerate_id(true);
        session_destroy();
    }
}
