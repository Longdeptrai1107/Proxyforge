# Kiểm chứng PHP ngày 26/11/2026

Runtime dùng để kiểm chứng: PHP 8.5.13 64-bit, cURL 8.23.0, extension chuẩn cURL/OpenSSL/zlib. Website hỗ trợ PHP 8.2+; không có package Composer/npm hoặc thư viện runtime ngoài. Node, OpenSSL CLI và Chromium chỉ dùng trong bộ kiểm tra phát triển.

| Hạng mục | Kết quả |
| --- | --- |
| PHP unit/integration engine | 15 ca đạt, gồm CSV giữ protocol/metadata và 10.000 handle đồng thời trong transport có kiểm soát |
| Kiểm tra tích hợp Node | 3 ca đạt, không bỏ qua trình duyệt |
| Network fixture | HTTP CONNECT, proxy HTTPS, SOCKS4a và SOCKS5 đều xác minh HTTPS thật thành công |
| TLS và timeout | Sai hostname, phản hồi không chứa IP bị loại; proxy đứng yên hết timeout tổng khoảng 3 giây |
| Website thật | Thiết lập mật khẩu, đăng nhập/đăng xuất, cookie, CSRF, quản lý nguồn, import chưa công bố, API/export chỉ live, cron CLI |
| Trình duyệt | Giao diện PHP thật + API có kiểm soát, điều hướng, 249 quốc gia, metadata, hộp thoại, tạm dừng/tiếp tục |
| Thư mục con | Asset và API dùng URL tương đối, không cần rewrite |
| Tải nguồn thực tế | 50/50 website/API đọc được, 67.951 bản ghi trước lọc trùng |
| Geo | IPv4/IPv6, quốc gia IP ưu tiên quốc gia đăng ký ASN; giữ metadata thành phố từ nguồn |
| Lưu phiên | File có PHP guard, khóa OS ngăn chạy chồng, thay nguyên tử, retry khi file bị giữ tạm trên Windows |

Phép đo giới hạn 10.000 dùng các handle cURL với transport file có kiểm soát, không mở 10.000 socket ra Internet. Phép thử bốn giao thức dùng máy chủ TLS và proxy trên loopback, CA riêng chỉ áp dụng trong test. Code production chặn proxy/feed mạng riêng và xác minh certificate bình thường.

Một worker PHP thật chạy với dữ liệu riêng, bật nguồn GcrawlAI và giữ danh mục đầy đủ 50 nguồn. Seed 7 proxy từng live từ phiên Python; giới hạn kho 1.000, đồng thời 10.000, timeout 3.000 ms. Worker bắt đầu từ CLI, không mở trình duyệt hoặc gọi API kích hoạt:

| Lượt | Ứng viên mới | Đã đo | Live đầu ra | Live cũ bị loại | Thời gian lượt |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 107 | 5 | 3 | 6.715 ms |
| 2 | 99 | 104 | 2 | 4 | 6.874 ms |

Hai mốc bắt đầu cách nhau **60.085 ms**. Nguồn được tải tại `2026-11-26T16:31:41.491Z` và `2026-11-26T16:32:41.445Z`; cả hai lượt chỉ có `alive` trong kho công bố, có ASN/server/quốc gia cho tất cả kết quả live và không có cảnh báo địa lý. Dữ liệu IP gzip có sẵn trong cache QA được đọc bằng PHP, không sử dụng engine Python để đo hay tra metadata.

Kết quả proxy công khai thay đổi theo thời điểm. Kiểm chứng này không cam kết shared hosting cho phép 10.000 socket hoặc cho phép mọi cổng TCP. Lịch nền cần cron của hosting hoặc worker CLI; request web đơn thuần không tự thức dậy.

Xem [báo cáo từng nguồn](source-audit.json) và [hướng dẫn chạy test](../README.md#kiểm-thử).
