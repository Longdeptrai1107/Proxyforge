<?php
declare(strict_types=1);

require_once __DIR__ . '/app/bootstrap.php';

function h(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

$error = null;
$auth = null;
try {
    ProxyForge\runtimeCheck();
    $store = new ProxyForge\Store(ProxyForge\configuration());
    $auth = new ProxyForge\Auth($store);
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $auth->verifyCsrf(is_string($_POST['csrf'] ?? null) ? $_POST['csrf'] : null);
        $password = is_string($_POST['password'] ?? null) ? $_POST['password'] : '';
        if ($auth->needsSetup) {
            if ($password !== ($_POST['confirm'] ?? null)) {
                throw new InvalidArgumentException('Hai mật khẩu không khớp.');
            }
            $auth->setup($password);
        } else {
            $auth->login($password);
        }
        header('Location: index.php', true, 303);
        exit;
    }
} catch (Throwable $failure) {
    $error = $failure->getMessage();
    http_response_code($auth ? 400 : 503);
}
$loggedIn = $auth && $auth->authenticated;
$setup = $auth && $auth->needsSetup;
?>
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Proxy Forge · PHP</title>
  <link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="assets/style.css">
  <?php if ($loggedIn): ?><script src="assets/app.js" defer></script><?php endif; ?>
</head>
<body>
<?php if (!$loggedIn): ?>
  <main class="login">
    <a class="brand" href="index.php"><span>◆</span> proxyforge<span class="brand-dot">.</span><small>PHP</small></a>
    <p class="eyebrow">PRIVATE WORKSPACE</p>
    <h1><?= $setup ? 'Tạo tài khoản quản trị.' : 'Chào mừng trở lại.' ?></h1>
    <p class="muted"><?= $setup ? 'Đặt mật khẩu cho website trước khi dùng bảng điều khiển.' : 'Đăng nhập để xem tiến độ, quản lý nguồn và xuất proxy live.' ?></p>
    <?php if ($error): ?><p class="notice error" role="alert"><?= h($error) ?></p><?php endif; ?>
    <?php if ($auth): ?>
    <form method="post" class="stack">
      <input type="hidden" name="csrf" value="<?= h($auth->csrf) ?>">
      <label>Mật khẩu<input type="password" name="password" required <?= $setup ? 'minlength="12"' : '' ?> maxlength="72" autocomplete="<?= $setup ? 'new-password' : 'current-password' ?>" autofocus></label>
      <?php if ($setup): ?><label>Nhập lại mật khẩu<input type="password" name="confirm" required minlength="12" maxlength="72" autocomplete="new-password"></label><?php endif; ?>
      <button class="primary" type="submit"><?= $setup ? 'Tạo tài khoản & mở dashboard' : 'Đăng nhập' ?></button>
    </form>
    <?php endif; ?>
    <p class="footnote">PHP thuần · Không Composer · Không framework · Dữ liệu lưu trên hosting của bạn.</p>
  </main>
<?php else: ?>
  <aside class="sidebar">
    <a class="brand" href="#overview"><span>◆</span> proxyforge<span class="brand-dot">.</span><small>PHP</small></a>
    <p class="eyebrow">WORKSPACE</p>
    <nav><a class="nav-link active" href="#overview" data-view="overview">◫ <span>Tổng quan</span></a><a class="nav-link" href="#proxies" data-view="proxies">▤ <span>Kho proxy</span><b id="navLive">0</b></a><a class="nav-link" href="#sources" data-view="sources">⌘ <span>Nguồn thu thập</span><b id="navSources">50</b></a><a class="nav-link" href="#setup" data-view="setup">⚙ <span>Cài đặt hosting</span></a></nav>
    <div class="sidebar-note"><span class="dot"></span> PHP ENGINE<p>Tự tải nguồn. Xác minh HTTPS.<br>Chỉ công bố proxy live.</p><a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a><a href="https://iptoasn.com" target="_blank" rel="noreferrer">ASN by IPtoASN</a></div>
    <button id="logout" class="text-button">Đăng xuất ↗</button>
  </aside>
  <main class="workspace">
    <header class="topbar"><span>WORKSPACE <i>/</i> <b id="breadcrumb">TỔNG QUAN</b></span><span id="connection" class="connection"><span class="dot"></span>Đang kết nối</span></header>
    <div class="page-heading"><div><p class="eyebrow">YOUR PROXY COMMAND CENTER</p><h1 id="pageTitle">Mọi proxy. Một nơi.</h1><p class="muted" id="pageDescription">Thu thập rộng. Kiểm tra thật. Chỉ giữ những kết nối tốt.</p></div><div class="heading-actions"><button id="openImport">↥ Nhập proxy</button><button class="primary" id="openExport">↧ Xuất live</button></div></div>
    <section class="stats" id="stats"><article><p>TỔNG PROXY LIVE</p><strong id="statTotal">0</strong><small>Đầu ra đã xác minh HTTPS</small></article><article class="live-card"><p>HTTPS LIVE</p><strong id="statAlive">0</strong><small><span class="dot"></span>Kiểm tra TLS của đích</small></article><article><p>WEBSITE NGUỒN</p><strong id="statSources">50</strong><small id="sourceSummary">Đang tải danh mục</small></article><article><p>ĐỘ TRỄ TRUNG BÌNH</p><strong id="statLatency">—</strong><small>ms · tại lần đo gần nhất</small></article></section>
    <section id="overview" class="view">
      <div class="panel automation-panel"><div class="panel-heading"><h2>TỰ ĐỘNG THU THẬP & KIỂM TRA</h2><span class="tag">PHP NATIVE</span></div><p id="autoStatus" class="muted" role="status">Đang đọc tiến độ backend…</p><div class="config-row"><label>Đồng thời<select id="concurrency"><option value="256">256</option><option value="1024">1.024</option><option value="2048">2.048</option><option value="5000">5.000</option><option value="10000" selected>10.000 proxy</option></select></label><label>Timeout<input value="3 giây · tổng mỗi proxy" disabled></label><label>Giới hạn lượt<select id="limit"><option value="1000">1.000</option><option value="10000">10.000</option><option value="50000">50.000</option><option value="100000" selected>100.000</option></select></label><div class="config-actions"><button id="resume" class="primary" hidden>Tiếp tục</button><button id="refresh">Lấy & check ngay</button><button id="stop" class="danger">Tạm dừng</button></div></div></div>
      <div id="workerNotice" class="notice" hidden></div>
      <div class="panel progress-panel"><div class="panel-heading"><h2>TIẾN ĐỘ BACKEND</h2><span id="jobStatus" class="tag">CHỜ CRON</span></div><div class="progress-summary"><strong id="jobCompleted">0 / 0</strong><span id="jobPercent">0%</span></div><progress id="jobProgress" max="100" value="0"></progress><div class="progress-details"><span id="jobDetail">Backend tự chạy theo cron/worker, không cần mở tab.</span><span id="jobElapsed">00:00</span></div></div>
    </section>
    <section id="proxies" class="view">
      <div class="panel inventory"><div class="panel-heading"><h2>KHO PROXY LIVE <span id="tableCount" class="count">0</span></h2><div class="inline"><button id="reload" class="small">↻ Làm mới</button><button id="clear" class="small danger">Xóa kho</button></div></div><div class="filters"><input id="search" placeholder="Tìm IP, nhà mạng, ASN…" aria-label="Tìm proxy"><select id="protocol"><option value="all">Mọi giao thức</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select><select id="country"><option value="all">Mọi quốc gia</option><option value="unknown">Chưa xác định</option></select><span class="live-filter"><span class="dot"></span>Chỉ HTTPS live</span></div><div class="table-scroll"><table><thead><tr><th>#</th><th>ĐỊA CHỈ PROXY</th><th>GIAO THỨC</th><th>ĐỘ TRỄ</th><th>IP ĐẦU RA</th><th>SERVER / ASN</th><th>VỊ TRÍ ƯỚC TÍNH</th><th></th></tr></thead><tbody id="proxyRows"></tbody></table><div class="empty" id="empty"><span>▤</span><h3>Đang chờ proxy qua HTTPS</h3><p>Proxy mới xuất hiện sau khi kiểm tra thành công.<br>Vòng lặp chạy ở backend theo lịch mỗi phút.</p></div></div><div class="pagination"><span id="paginationSummary">0 proxy</span><div class="inline"><button id="previous" class="small">‹</button><span id="page">1 / 1</span><button id="next" class="small">›</button></div></div></div>
    </section>
    <section id="sources" class="view" hidden><div class="panel"><div class="panel-heading"><h2>WEBSITE / API NGUỒN</h2><div class="inline"><button id="enableSources" class="small">Bật tất cả</button><button id="disableSources" class="small">Tắt tất cả</button><button id="openSource" class="primary small">+ Thêm nguồn</button></div></div><p class="muted">50 nhà cung cấp mặc định. Tạm dừng lượt đang chạy trước khi đổi nguồn.</p><div id="sourceList" class="source-list"></div></div></section>
    <section id="setup" class="view" hidden><div class="panel setup-panel"><div class="panel-heading"><h2>CHẠY TỰ ĐỘNG TRÊN HOSTING</h2><span class="tag">MỖI 60 GIÂY</span></div><p>Trong cPanel → Cron Jobs, đặt lịch mỗi phút với lệnh dưới đây. Thay <code>php</code> bằng đường dẫn PHP CLI của hosting nếu cần.</p><pre id="cronCommand">Đang tải…</pre><p>Trên VPS có thể chạy một worker liên tục; worker bắt đầu ngay và tự lặp, không cần trình duyệt.</p><pre id="workerCommand">Đang tải…</pre><p>Nếu hosting chỉ hỗ trợ cron qua URL, dùng URL bí mật sau hoặc gửi khóa trong header <code>X-Proxy-Forge-Cron</code>. Giữ khóa như mật khẩu.</p><details><summary>Hiện URL cron</summary><pre id="cronURL"></pre></details><p class="notice">PHP chạy theo request không tự thức dậy khi không có truy cập. Cần cron của hosting hoặc worker để chạy cả lúc đóng tab. Cron mới bật mặc định và không cần bấm Bắt đầu.</p><p id="runtime" class="muted"></p><h3>Dữ liệu và kiểm tra live</h3><p>Chỉ dùng PHP 8.2+ 64-bit, extension chuẩn cURL/OpenSSL; zlib bổ sung dữ liệu ASN/quốc gia. Không Composer, không framework, không thư viện JavaScript ngoài. Không cần database. Phiên được lưu bằng file có khóa và thay nguyên tử.</p><p>10.000 là mức đồng thời được yêu cầu; hosting phải cho phép đủ socket, bộ nhớ và thời gian chạy. Nếu hosting giới hạn, giảm đồng thời trong <code>config.local.php</code>. Timeout 3 giây tính cả kết nối, giao thức proxy và HTTPS.</p><p>Vị trí là ước tính của IP proxy. Proxy công khai có thể ghi lưu lượng; dùng cho thử nghiệm không nhạy cảm. Dữ liệu DB-IP Lite: CC BY 4.0; IPtoASN: PDDL.</p></div></section>
    <footer>Proxy Forge · PHP thuần <span>HTTP · HTTPS · SOCKS4 · SOCKS5</span></footer>
  </main>
  <dialog id="importDialog"><form id="importForm"><div class="dialog-heading"><h2>Nhập proxy</h2><button type="button" data-close="importDialog">×</button></div><p class="muted">Nhận TXT/CSV/JSON tối đa 8 MB. Cron/worker kiểm tra trước khi công bố.</p><label>Giao thức mặc định<select id="importProtocol"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select></label><input id="importFile" type="file" accept=".txt,.csv,.json"><textarea id="importText" rows="9" required placeholder="http://IP:PORT"></textarea><button class="primary" type="submit">Nhập & xếp lịch kiểm tra</button></form></dialog>
  <dialog id="exportDialog"><form id="exportForm"><div class="dialog-heading"><h2>Xuất proxy live</h2><button type="button" data-close="exportDialog">×</button></div><p class="muted">Chỉ xuất các proxy đã qua HTTPS thật.</p><label>Định dạng<select id="exportFormat"><option value="txt">TXT</option><option value="csv">CSV</option><option value="json">JSON</option></select></label><label>Quốc gia<select id="exportCountry"><option value="all">Mọi quốc gia</option><option value="unknown">Chưa xác định</option></select></label><label class="checkbox"><input id="exportBare" type="checkbox">TXT chỉ IP:PORT</label><button class="primary" type="submit">Tải xuống</button></form></dialog>
  <dialog id="sourceDialog"><form id="sourceForm"><div class="dialog-heading"><h2>Thêm nguồn HTTPS</h2><button type="button" data-close="sourceDialog">×</button></div><label>Tên nguồn<input id="sourceName" maxlength="120"></label><label>URL công khai<input id="sourceURL" type="url" required placeholder="https://example.com/proxies.txt"></label><label>Giao thức<select id="sourceProtocol"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select></label><button class="primary" type="submit">Thêm nguồn</button></form></dialog>
  <dialog id="clearDialog"><div class="dialog-heading"><h2>Xóa kho proxy?</h2><button data-close="clearDialog">×</button></div><p>Proxy live và hàng đợi nhập sẽ được xóa. Danh sách nguồn được giữ lại.</p><button class="danger" id="confirmClear">Xóa kho</button></dialog>
  <div class="toast" id="toast" role="status" hidden></div>
<?php endif; ?>
</body>
</html>
