# Proxy Forge — PHP thuần cho hosting

Phiên bản website độc lập, viết bằng PHP 8.2+, HTML/CSS/JavaScript thuần. **Không Composer, framework, npm, Python, Node, thư viện PHP/JavaScript ngoài hoặc database.** Dùng extension chuẩn **cURL, OpenSSL**; **zlib** để bổ sung ASN/quốc gia từ dữ liệu công khai. Asset nằm sẵn trong gói, không tải script hoặc font từ CDN.

Backend tự tải **50 website/API**, lọc trùng, kiểm tra HTTP / HTTPS / SOCKS4 / SOCKS5, mặc định **10.000 đồng thời**, **timeout tổng 3 giây/proxy**. Giao diện, API và TXT/CSV/JSON chỉ công bố proxy đã qua HTTPS/TLS và trả IP hợp lệ. Proxy live cũ được đo lại trong mỗi lượt; thất bại thì loại, chưa đo xong thì giữ kết quả cũ.

## Upload lên hosting/cPanel

1. Tải `ProxyForge-PHP-Hosting.zip` từ [GitHub Releases](https://github.com/Longdeptrai1107/Source-QLTK-NRO/releases/latest), giải nén và upload **nội dung thư mục `ProxyForge-PHP`** vào `public_html/proxyforge/` hoặc thư mục website bạn chọn. Không cần upload bản Python/C#.
2. Chọn **PHP 8.2 trở lên, 64-bit**, bật `curl` và `openssl`; bật `zlib` để tra địa lý. Kiểm tra PHP có quyền ghi `storage/`. Không cần cấp quyền `777`; quyền phải phù hợp user PHP của hosting.
3. Mở `https://ten-mien-cua-ban/proxyforge/`, đặt mật khẩu quản trị ít nhất 12 ký tự. Tài khoản không có mật khẩu mặc định. Các API danh sách/xuất và thao tác đều cần đăng nhập.
4. Vào **cPanel → Cron Jobs**, đặt một lệnh chạy **mỗi phút** như bên dưới. Dashboard → **Cài đặt hosting** hiển thị lệnh có đường dẫn file thực tế.

```cron
* * * * * /usr/local/bin/php /home/USERNAME/public_html/proxyforge/cron.php >> /home/USERNAME/proxyforge-cron.log 2>&1
```

Thay đường dẫn PHP và `USERNAME` theo hosting. Trong các ô cPanel, chọn `*` cho minute/hour/day/month/weekday; ô Command chỉ nhập phần từ `/usr/local/bin/php`, không nhập lại năm dấu `*`.

**Cron đầu tiên tự chạy ngay, không cần bấm nút Bắt đầu.** Có thể chạy lệnh một lần sau khi upload để có kết quả sớm. Các lần sau tự tải mới và kiểm tra theo lịch, kể cả khi đóng tab. File lock ngăn cron chạy chồng; một lượt dài thì lần cron đến trong lúc bận sẽ bỏ qua, lần cron rảnh tiếp theo sẽ chạy.

PHP chạy qua request không có khả năng tự thức dậy khi không có request nào. Vì vậy cần **cron của hosting hoặc worker CLI** cho yêu cầu tự chạy liên tục; JavaScript của dashboard chỉ đọc tiến độ, không kích hoạt vòng lặp. Hosting phải cho phép kết nối TCP ra các cổng proxy. Nếu chỉ cho phép HTTPS/443, sẽ tải được nguồn nhưng phần lớn kiểm tra proxy không kết nối được.

## VPS / PHP CLI

```sh
php /duong-dan/proxyforge/worker.php
```

Worker tự bật, chạy ngay và lặp theo mốc 60 giây, không chạy chồng. Dùng systemd/Supervisor của VPS để giữ tiến trình. Khi một lượt vượt 60 giây, worker chạy lượt tiếp theo sau khi lượt hiện tại kết thúc. `php worker.php --once` bật tự động và chạy một lượt để kiểm tra cài đặt.

## Hosting chỉ hỗ trợ cron qua URL

Mở **Cài đặt hosting → Hiện URL cron** trong dashboard. Gọi URL này bằng lịch HTTP của hosting mỗi phút. Khóa riêng được tạo ngẫu nhiên cho từng lần cài đặt; không dùng mật khẩu quản trị làm khóa cron.

Có thể giữ khóa ngoài query string bằng header:

```sh
curl -H 'X-Proxy-Forge-Cron: KHOA_TU_DASHBOARD' https://ten-mien/proxyforge/cron.php
```

Lệnh này là tùy chọn triển khai; ứng dụng không yêu cầu cài chương trình `curl` riêng. Nếu hosting ngắt request HTTP dài, dùng cron CLI thay cho cron URL. HTTP cron trả kết quả sau lượt kiểm tra; không cần giữ tab trình duyệt mở.

## Cấu hình

Tạo `config.local.php` bên cạnh `config.php` để ghi đè tùy chọn. File này không có trong Git hoặc gói phát hành, không bị thay khi cập nhật.

```php
<?php
return [
    // Nên đặt ngoài public_html khi hosting cho phép.
    'data_dir' => '/home/USERNAME/proxyforge-private',
    'concurrency' => 10000,
    'max_proxies' => 100000,
    'enrich_geo' => true,
    // Nếu PHP chưa có CA bundle, chỉ tới bundle của hosting:
    // 'ca_file' => '/duong-dan/cacert.pem',
];
```

10.000 là giới hạn đồng thời được yêu cầu, không đảm bảo shared hosting cấp đủ 10.000 socket. Có thể đặt `concurrency` thành `256`, `1024` hoặc `2048` để phù hợp hosting. Timeout vẫn là tổng **3.000 ms** cho mỗi phép đo, gồm TCP, giao thức proxy, TLS và phản hồi IP. Không tắt xác minh certificate để chữa lỗi CA.

`check_url` mặc định là `https://api.iplocate.io/ip`; có thể đổi thành dịch vụ HTTPS echo do bạn kiểm soát. Phản hồi cần HTTP 200 và một IP thuần hoặc JSON `ip`/`origin`, tối đa 64 KB. Không có cơ chế fallback sang kết nối trực tiếp khi proxy lỗi.

Các nguồn chỉ nhận HTTPS cổng 443. DNS được kiểm tra IP công khai rồi ghim bằng `CURLOPT_RESOLVE`; mỗi chuyển hướng đều được kiểm tra lại. Phản hồi nguồn tối đa 4 MB sau giải nén. Parser đọc JSON, text, bảng HTML và các mẫu mã hóa giới hạn; không chạy JavaScript của nguồn.

## Apache / Nginx và dữ liệu

- Apache 2.4 có `.htaccess` chặn `storage`, `app`, `resources`, `tests` và tắt directory listing.
- Với Nginx, cấu hình deny các thư mục này; ví dụ cho vị trí `/proxyforge/`:

```nginx
location ~ ^/proxyforge/(?:storage|app|resources|tests)/ {
    deny all;
}
```

Đặt location này trước location PHP tổng quát trong cấu hình regex của website, hoặc đặt từng thư mục thành location `^~`. Cấu hình PHP-FPM theo hosting; không cần rewrite cho API. URL dùng đường dẫn tương đối nên chạy được cả ở domain gốc hoặc thư mục con.

Dữ liệu mặc định ở `storage/state.php`, gồm hash mật khẩu, khóa cron, nguồn và proxy. File bắt đầu bằng mã PHP từ chối HTTP; nội dung JSON được thay nguyên tử dưới `flock`. Nên đặt `data_dir` ngoài web root như ví dụ. Đừng upload hoặc đưa thư mục phiên của máy khác vào gói website. Khi cập nhật, giữ `config.local.php` và dữ liệu đang dùng.

**Tạm dừng** lưu trạng thái ngưng lịch và hủy lượt đang chạy. **Tiếp tục** hoặc **Lấy & check ngay** xếp yêu cầu để cron/worker nhận; với cron mỗi phút, có thể cần đợi tới lần cron kế tiếp. Khởi động lại worker CLI luôn tự bật; cron giữ lựa chọn tạm dừng giữa các lần gọi. Nếu hosting dừng worker bất thường, lượt sau khôi phục khóa và giữ các kết quả đã xác minh.

## Giao diện và API

- Đăng nhập, dashboard tiến độ, quản lý 50 nguồn, thêm nguồn HTTPS, nhập TXT/CSV/JSON.
- Bộ lọc 249 mã quốc gia + chưa xác định; địa lý từ feed được giữ và bổ sung bằng DB-IP Lite/IPtoASN khi có thể.
- Tra ASN/quốc gia bằng file gzip cục bộ và đọc streaming, giữ cache nếu tải mới lỗi. Dữ liệu địa lý là dữ liệu, không phải thư viện runtime.
- Export TXT/CSV/JSON chỉ live, hỗ trợ lọc quốc gia/giao thức. Vị trí là ước tính IP máy chủ, không phải địa chỉ chính xác.
- `GET api.php?action=state|sources|proxies|export|info`; POST `auto`, `stop`, `refresh`, `import`, `clear`, `sources/toggle`, `sources/add`, `logout`. POST nhận JSON và header `X-Proxy-Forge-Token` từ phiên quản trị. API dùng session cookie, không mở dữ liệu ra công khai mặc định.

Ghi công: [DB-IP Country Lite](https://db-ip.com) theo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [IPtoASN](https://iptoasn.com) theo [PDDL](https://opendatacommons.org/licenses/pddl/). Proxy công khai có thể ghi lưu lượng; dùng cho thử nghiệm không nhạy cảm.

## Kiểm thử

```sh
php tests/run.php
```

Test PHP dùng dữ liệu riêng trong thư mục tạm, không cần thư viện. Bao phủ parser, địa chỉ công khai, 50 nguồn/249 quốc gia, lưu phiên, khóa ngăn chồng, chu kỳ 60 giây, dừng giữa lượt, output live, import chưa công bố, khôi phục worker và **10.000 handle đang hoạt động** trong bộ kiểm tra có kiểm soát. Phép thử giới hạn scheduler không mở 10.000 socket ra Internet.

Kiểm tra tích hợp và trình duyệt bổ sung cho người phát triển dùng Node chuẩn, OpenSSL CLI và Chromium đã cài; các chương trình này **không cần để chạy website**:

```sh
node --test tests/integration.test.mjs
php tests/audit-sources.php
```

Đặt `PHP_BINARY`, `OPENSSL_BINARY`, `PROXYFORGE_BROWSER` khi executable không nằm ở đường dẫn thông thường. Kết quả rà nguồn thực tế: [50/50 website đọc được ngày 26/11/2026](docs/source-audit.json). Đọc được danh sách không đảm bảo proxy trong danh sách còn hoạt động.
