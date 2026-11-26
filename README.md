# Proxy Forge — Python + C# WinForms

Ứng dụng cục bộ tự tải proxy từ **50 website/API mỗi 60 giây**, lọc trùng và kiểm tra HTTP / HTTPS / SOCKS4 / SOCKS5 với **10.000 proxy đồng thời, timeout tổng 3 giây**. Bảng, API và tệp xuất TXT/CSV/JSON **chỉ chứa proxy live đã qua HTTPS thật**. Web và WinForms gọi cùng engine Python, hiển thị nhà mạng/server, ASN, vị trí ước tính và bộ lọc **249 quốc gia/vùng lãnh thổ**.

> Chỉ dùng proxy công khai cho thử nghiệm không nhạy cảm. Proxy miễn phí có thể ghi lại dữ liệu hoặc ngừng hoạt động bất cứ lúc nào. Không gửi mật khẩu, cookie hay dữ liệu cá nhân qua proxy công cộng; kiểm tra thành công không phải cam kết về độ riêng tư hoặc độ ổn định.

## Tải bản phát hành

Tải tại [GitHub Releases](https://github.com/Longdeptrai1107/Source-QLTK-NRO/releases/latest):

| Gói | Cách chạy | Yêu cầu |
| --- | --- | --- |
| `ProxyForge-Python-Web.zip` | Giải nén, mở `Run-Python.cmd` | Windows, Python 3.11+ |
| `ProxyForge-CSharp-WinForms.zip` | Giải nén cả gói, mở `Run-WinForms.cmd`; có sẵn `winforms/ProxyForge.WinForms.exe` | Windows, .NET Framework 4.8, Python 3.11+ |

Cả hai gói kèm mã nguồn Python và C#, giao diện web, kiểm thử và hướng dẫn build. Bản WinForms dùng engine Python đi kèm; giữ nguyên cấu trúc thư mục khi giải nén. Dependency Python được cài ở lần chạy đầu. Đối chiếu tệp tải về bằng `SHA256SUMS.txt` của bản phát hành.

## Chạy web Python

Yêu cầu Python 3.11 trở lên và truy cập Internet.

1. Mở `Run-Python.cmd`.
2. Lần đầu chương trình tạo môi trường ảo `.venv`, cài `aiohttp`, rồi khởi động web ở `http://127.0.0.1:8787`.
3. Backend tự bắt đầu tải nguồn và kiểm tra ngay, sau đó lặp mỗi **60 giây**, kể cả khi chưa mở trình duyệt. Không cần bấm bắt đầu. Proxy mới xuất hiện khi qua HTTPS, proxy cũ bị loại khi đo lại thất bại. **Tạm dừng** ngưng phiên hiện tại; **Tiếp tục tự động** chạy lại. Mỗi lần mở backend luôn tự chạy, kể cả phiên trước đã dừng.

Hoặc mở PowerShell tại thư mục mã nguồn và chạy:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m proxyforge.web
```

`Run-Python.cmd` gọi `Start-Web.ps1`: nếu backend của chính dự án đang giữ cổng, script lưu phiên và khởi động lại để nạp mã mới, chờ backend bật tự động rồi mới mở trình duyệt. Điều này tránh giao diện mới gọi `/api/auto` hoặc `/api/refresh` vào backend cũ gây 404. Script không dừng ứng dụng khác giữ cổng. Đổi cổng bằng `$env:PORT=8788` trước khi chạy; URL trình duyệt dùng đúng cổng đã chọn.

Có thể đổi endpoint xác minh IP thành dịch vụ HTTPS echo do bạn kiểm soát bằng `$env:CHECK_URL='https://example.com/ip'`. Endpoint phải trả **một IP thuần** hoặc JSON có trường `ip` / `origin`, tối đa 64 KB. TLS được xác minh bình thường.

## Chạy C# WinForms

`Run-WinForms.cmd` tự build khi mã nguồn C# hoặc script build mới hơn file thực thi, sau đó mở `winforms\ProxyForge.WinForms.exe`. Ứng dụng cần Windows, .NET Framework 4.8 và Python 3.11+. Nó ưu tiên môi trường Python có sẵn của dự án, hoặc tự tạo venv trong `%LOCALAPPDATA%\ProxyForge` và cài dependency nếu thiếu. Phiên desktop được lưu tại `%LOCALAPPDATA%\ProxyForge\state.json`; phiên web dùng `data\state.json` trong thư mục mã nguồn. Có thể đặt `PROXYFORGE_DATA` để chọn thư mục dữ liệu riêng.

Build trực tiếp:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-WinForms.ps1
```

Script ưu tiên compiler Windows có sẵn trong .NET Framework, tạo file `winforms\ProxyForge.WinForms.exe`; không yêu cầu .NET SDK. Nếu cài Visual Studio Build Tools, có thể build `winforms\ProxyForge.WinForms.csproj` bằng MSBuild. Giữ thư mục `proxyforge`, `public`, `requirements.txt` bên cạnh dự án vì WinForms khởi động backend từ đây.

Trong WinForms, backend tự chạy ngay khi mở cửa sổ, không cần nút Start. **Collect + check now** cập nhật ngay một lượt, **Stop** tạm ngưng vòng lặp và tác vụ, **Resume auto** tiếp tục sau khi đã tạm dừng. Nhấp đúp dòng proxy để sao chép. **Manage sources** bật/tắt nhà cung cấp hoặc thêm URL HTTPS; dừng lượt đang chạy trước khi đổi nguồn. **Import** nhận TXT/CSV/JSON tối đa 8 MB và kiểm tra ngay trước khi công bố kết quả. **Export** lưu proxy live theo quốc gia đang chọn. Đóng WinForms lưu kết quả rồi tắt backend riêng; mở lại luôn tự chạy.

## Giao diện web dùng Node.js (tùy chọn)

Có thể chạy `node server.mjs` với Node.js 22+ để dùng backend Node. Node và Python là hai server riêng, cùng phục vụ `public/` và dùng chung `proxyforge/sources.json`. Cả hai có cùng vòng lặp 60 giây, 10.000 kiểm tra đồng thời, timeout 3 giây, đầu ra chỉ live, tra ASN/vị trí và lọc quốc gia. `PROXYFORGE_DATA` chọn thư mục phiên cho cả hai backend.

## Danh sách website nguồn

`proxyforge/sources.json` có **50 website/API thuộc 50 domain nguồn khác nhau**, bật mặc định. Mỗi nhà cung cấp được tính một lần; nhiều endpoint HTTP, HTTPS, SOCKS4, SOCKS5 của cùng website được gộp trong trường `feeds`. Không có GitHub raw hoặc CDN trỏ tới file GitHub trong danh mục. Các nguồn có thể dùng chung dữ liệu công khai; engine loại trùng theo giao thức + IP + cổng.

Xem [danh sách 50 nguồn](docs/SOURCES.md) và [báo cáo tải nguồn](docs/source-audit.json). Lượt rà ngày **26/11/2026** tải/đọc được **50/50 nguồn**, có đủ bốn giao thức. Đây là kiểm tra khả năng tải danh sách và cú pháp địa chỉ; proxy thực sự hoạt động được xác định bằng phép đo HTTPS trong từng lượt tự động. Một số API trả một trang hoặc một tập con công khai.

Có thể bật/tắt từng nguồn trong giao diện; cài đặt được giữ khi khởi động lại. Lỗi một nguồn không làm dừng các nguồn còn lại. Parser đọc JSON/API, bảng HTML và một số cách mã hóa địa chỉ đơn giản, bỏ địa chỉ ví dụ trong khối mã/tài liệu và không chạy JavaScript từ website. Mỗi lượt tự động hoặc **Lấy & check ngay** đều tải lại nguồn và đo mạng mới.

Không vượt CAPTCHA, không thu thập nội dung cần đăng nhập và không dùng cookie/API key. Có thể thêm URL HTTPS công khai. Engine chỉ truy cập domain công khai, chặn DNS trỏ vào loopback/mạng riêng, giới hạn mỗi phản hồi 4 MB và kiểm tra thủ công tối đa 500 nguồn.

## Vòng lặp và kiểm tra live

- **HTTPS thật** — bắt tay với proxy, mở CONNECT/SOCKS tunnel, xác minh TLS của endpoint và đọc phản hồi IP. Kết quả `HTTPS sống` chỉ có nghĩa là yêu cầu đó thành công tại thời điểm đo.
- Nhãn giao thức **HTTPS** là kết nối TLS tới chính proxy. Nhãn **HTTP** vẫn có thể mở CONNECT để truy cập đích HTTPS. Giữ giao thức mà nguồn cung cấp, sau đó xác minh theo chế độ đã chọn.
- **Mỗi 60 giây** tính từ lúc bắt đầu lượt trước: tải lại các nguồn đang bật, hợp nhất ứng viên mới với proxy live cũ, rồi đo tất cả trong cùng lượt. Nếu lượt trước chưa xong sau 60 giây, đợi nó xong rồi chạy lượt tiếp theo; không chạy chồng hay tạo hàng đợi các lượt trễ.
- **Chỉ output live**: proxy mới chưa đo và kết quả bắt tay đơn thuần không được công bố. Bảng, thống kê, API, tệp xuất và phiên lưu chỉ chứa `alive`. Trong lúc đo lại, giữ bản live trước đó; đo thất bại thì loại ngay, đo thành công thì cập nhật độ trễ/thời điểm đo.
- **Tạm dừng** hủy lượt hiện tại và tắt lịch tiếp theo trong phiên đang chạy. Giữ kết quả live đã đo và bản live cũ của proxy chưa đo xong; các thất bại đã xác định vẫn bị loại. **Tiếp tục tự động** chạy lại ngay; khởi động lại backend cũng luôn tự chạy.
- **Nhập proxy** tự đo HTTPS, lọc trùng và chỉ công bố những proxy thành công. Có thể nhập khi engine đang rảnh; nhấn Dừng nếu đang có lượt chạy.
- **Timeout tổng 3 giây** cho mỗi proxy, bao gồm kết nối, giao thức proxy, TLS và phản hồi IP của đích HTTPS. Tải danh sách nguồn có timeout riêng 12 giây.
- **10.000 kiểm tra đồng thời** là mặc định và giới hạn tối đa. Có thể giảm số kết nối trong giao diện khi đã dừng tự động. Số socket thực tế và tốc độ còn phụ thuộc máy, hệ điều hành và mạng.
- Vòng lặp được khởi động từ backend và tiếp tục khi đóng tab web. Khi tắt backend, phiên live và cấu hình nguồn được lưu; lần mở tiếp theo luôn tự chạy, bỏ qua trạng thái tạm dừng cũ.

API `POST /api/auto` nhận `{"enabled":true,"concurrency":10000,"limit":100000}`. `POST /api/refresh` chạy một lượt tải + kiểm tra mới. `POST /api/check` đo lại kho, `POST /api/collect` cũng tải + kiểm tra trong chế độ live. `POST /api/stop` tắt tự động và hủy lượt đang chạy. `GET /api/state` trả lịch tại `automation`, còn `/api/proxies` và `/api/export` luôn lọc đầu ra live, kể cả khi yêu cầu `status=all`. Các lệnh POST cần token của phiên.

Ước lượng bảo thủ khi mọi proxy đều chờ hết timeout:

```text
thời gian ≈ số proxy ÷ số kết nối đồng thời × timeout
100.000 ÷ 10.000 × 3 giây ≈ 30 giây phần đo
10.000 ÷ 10.000 × 3 giây ≈ 3 giây phần đo
```

Đây chỉ là ước lượng: đa số proxy chết có thể timeout, proxy tốt kết thúc sớm, trong khi TLS, hệ điều hành, ISP, file descriptor và giới hạn băng thông có thể làm chậm hơn. **Không cam kết 100.000 proxy / 10 giây**, kể cả khi dùng 1 CPU.

## Server, vị trí và lọc quốc gia

Thông tin do nguồn cung cấp được giữ lại. Sau lượt kiểm tra, phần còn thiếu được bổ sung bằng cơ sở dữ liệu IPv4/IPv6 cục bộ: **IPtoASN** cho tên đơn vị vận hành/nhà mạng và ASN, **DB-IP Country Lite** cho quốc gia. Dữ liệu được tải vào thư mục `geo` trong thư mục phiên và dùng lại; nếu tải mới hỏng, bản cache còn dùng được vẫn được giữ.

Vị trí là ước tính của IP máy chủ proxy, không phải địa chỉ chính xác hay IP đầu ra. Thành phố chỉ hiện khi nguồn có cung cấp. Nếu DB-IP chưa dùng được, quốc gia đăng ký ASN có thể được dùng làm dự phòng và được ghi rõ trong `locationSource`. Bộ lọc có 249 mã ISO cùng lựa chọn chưa xác định; số mã không đảm bảo có proxy sống ở mọi quốc gia. TXT, CSV và JSON hỗ trợ lọc quốc gia; CSV/JSON có thêm thông tin server và vị trí.

Ghi công: [IP Geolocation by DB-IP](https://db-ip.com), dữ liệu Lite theo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [IPtoASN](https://iptoasn.com), dữ liệu theo [PDDL](https://opendatacommons.org/licenses/pddl/).

## Lưu dữ liệu và bảo mật

- Web chỉ bind vào `127.0.0.1`, không mở cổng ra LAN. Mỗi lần chạy tạo token CSRF trong bộ nhớ và yêu cầu token cho thao tác POST.
- Feeds chỉ tải qua HTTPS và DNS của feed bị ghim vào IP công khai đã kiểm tra. Kết nối proxy thử đến endpoint HTTPS cố định; proxy lỗi không tự fallback sang mạng trực tiếp.
- Danh sách, trạng thái kiểm tra và cài đặt nguồn được lưu cục bộ trong `state.json`. Có thể xuất trước khi xóa kho.
- Danh sách nhập và feed được lọc để chỉ nhận IP công khai; giao diện không nhận địa chỉ loopback, LAN, dải đặc biệt hoặc proxy có username/password.

## Kiểm thử

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --test test/*.test.mjs
node --check .\public\app.js
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-WinForms.ps1
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\test-winforms.ps1
.\.venv\Scripts\python.exe .\scripts\audit-sources.py --output .\docs\source-audit.json
```

Kiểm thử bao phủ bộ lọc IP/URL, parser, bốn giao thức, metadata, timeout, lọc trùng và dọn worker khi lỗi/dừng. Các ca tự động kiểm tra backend tự chạy trước bất kỳ yêu cầu HTTP nào, tự tiếp tục sau khi khởi động dù phiên cũ đã dừng, tải nguồn mới mỗi lượt, lượt dài không chồng, output live từng phần, import/xuất chỉ live và đúng 10.000 phép đo đồng thời trong bộ kiểm tra có kiểm soát (không mở 10.000 kết nối tới website bên ngoài). Tra cứu địa lý bao phủ IPv4/IPv6, ưu tiên quốc gia IP hơn quốc gia ASN và giữ cache khi tải mới hỏng.

Kiểm thử giao diện chạy HTML/JavaScript thật bằng Chrome hoặc Edge headless trên phiên dữ liệu giả riêng, không chạm kho proxy đang lưu. Test kiểm tra điều hướng, nút và biểu mẫu nhập, quản lý nguồn, thu thập/kiểm tra/dừng, bộ lọc, hộp thoại và xóa có xác nhận. Nếu trình duyệt nằm ngoài đường dẫn thông dụng, đặt `PROXYFORGE_BROWSER` tới file thực thi; test sẽ báo bỏ qua khi không tìm thấy trình duyệt. Test Python kiểm tra JSON xuất với 0, 1, 2 và 501 proxy, bao gồm ranh giới phân lô 500 dòng.

Phép thử WinForms cần desktop Windows, tự tạo thư mục dữ liệu mới và mở giao diện với backend Python thật. Nó kiểm tra tự chạy khi khởi động, cấu hình 10.000/3 giây, 249 quốc gia, server/vị trí, bộ lọc, xóa proxy lỗi, tạm dừng/tiếp tục và lấy/check ngay. `audit-sources.py` tải danh sách công khai thật nên kết quả phụ thuộc trạng thái website tại thời điểm chạy.

Xem [kết quả kiểm chứng ngày 26/11/2026](docs/VERIFICATION.md), bao gồm đo proxy công khai qua HTTPS thật và thao tác trên backend thật.
