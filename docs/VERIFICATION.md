# Kiểm chứng ngày 26/11/2026

Các phép thử hồi quy dùng thư mục dữ liệu riêng trong thư mục tạm. Sau khi xác nhận lỗi 404 do tiến trình cũ ở cổng 8787, launcher mới đã lưu phiên, thay đúng backend của dự án và cho nó tự tải/kiểm tra theo yêu cầu.

| Hạng mục | Kết quả |
| --- | --- |
| Danh mục | 50 website/API, 50 domain nguồn, bật mặc định; endpoint cùng nhà cung cấp được gộp lại |
| Tải nguồn bằng Python | 50/50 trả danh sách đọc được; [báo cáo từng nguồn](source-audit.json) |
| Tải nguồn bằng Node | 50/50 trả danh sách đọc được, bao gồm các endpoint giao thức bổ sung |
| Python | 28 ca kiểm thử đạt |
| Node và giao diện headless | 20 ca kiểm thử đạt, không bỏ qua trình duyệt |
| PHP thuần | 15 ca PHP + 3 ca tích hợp/network/trình duyệt đạt; 50/50 nguồn đọc được; [kiểm chứng PHP](../php/docs/VERIFICATION.md) |
| WinForms | Build thành công; mở cửa sổ và chạy với backend Python thật |
| Bộ lọc quốc gia | 249 mã ISO cùng lựa chọn mọi quốc gia/chưa xác định; danh sách và tệp xuất lọc cùng quốc gia |
| Tự động | Backend khởi động là chạy ngay, kể cả phiên cũ đã tạm dừng; không cần trình duyệt hoặc POST kích hoạt; lặp mỗi 60 giây |
| Đồng thời và timeout | Mặc định/tối đa 10.000; tổng timeout 3.000 ms, xác minh HTTPS thật |
| Output | Bảng, thống kê, API và tệp xuất chỉ chứa `alive`; cập nhật khi từng phép đo hoàn tất |

Phép thử trình duyệt tự động dùng HTML/JavaScript thật trên Chrome/Edge để kiểm tra điều hướng, nút, biểu mẫu, hộp thoại, quản lý nguồn, tạm dừng/tiếp tục/cập nhật ngay, bộ lọc, metadata và xóa có xác nhận. Xác nhận đã tự chạy khi kết nối, không hiện nút yêu cầu bắt đầu, mặc định 10.000 đồng thời, timeout cố định 3 giây và chỉ có lựa chọn xuất live. WinForms được thử với backend Python thật: tự bật khi mở cửa sổ dù phiên lưu là dừng, cột server/ASN/vị trí, 249 quốc gia, bộ lọc, xóa proxy đo thất bại, tạm dừng/tiếp tục và cập nhật ngay.

Các test engine Python và Node dùng 10.001 ứng viên cùng bộ kiểm tra có chốt chờ để đo số tác vụ hoạt động: đúng **10.000** đồng thời, ứng viên cuối chờ có chỗ. Đây là phép thử giới hạn worker; không mở 10.000 socket ra website bên ngoài. Các ca còn lại kiểm tra proxy cũ vẫn hiện khi đo lại, proxy mới chỉ hiện sau HTTPS, xóa thất bại ngay, dừng giữa lượt, tự chạy lại khi backend mở dù phiên cũ đã dừng, tải lại nguồn mỗi lượt và lượt dài không chồng. Test khởi động server đợi phép đo đầu tiên mà không gửi bất kỳ yêu cầu HTTP nào, xác nhận backend tự khởi động vòng lặp. Test Python còn hủy việc lưu giữa chừng để xác nhận lần lưu cuối cùng được hoàn tất đúng.

Ở cổng 8787, backend cũ trả 404 cho `/api/auto` và `/api/refresh`, không có trường `automation`. `Start-Web.ps1 -NoBrowser` xác định đúng tiến trình Python qua đường dẫn venv của dự án, lưu phiên và nạp backend mới. Backend mới tự tải **50/50 nguồn**, đo **40.905 ứng viên**, công bố **35 proxy live** trong lượt đầu dài **36,438 giây**, rồi đặt lịch lượt sau tại mốc 60 giây. Toàn bộ lượt này được kích hoạt trong startup; không bấm bắt đầu hoặc gọi POST để bật. Giao diện thật ở 8787 đã tải lại, hiển thị lịch tự động và ẩn nút bắt đầu.

Phép thử tự động trên mạng thật dùng dữ liệu riêng, bật GcrawlAI và giữ danh mục đầy đủ 50 nguồn. Hai lượt chạy ở cấu hình 10.000 đồng thời, timeout 3 giây, giới hạn kho 1.000 ứng viên:

| Lượt | Ứng viên mới | Đã đo HTTPS | Live đầu ra | Live cũ bị loại | Toàn bộ lượt |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 110 | 9 | 1 | 11,614 giây |
| 2 | 100 | 109 | 8 | 1 | 4,048 giây |

Mốc bắt đầu hai lượt cách nhau **59.999 ms**. Thời điểm tải nguồn lần lượt `2026-11-26T15:24:01.935Z` và `2026-11-26T15:25:01.403Z`, xác nhận đã tải mới thay vì dùng lại cache. Lượt đầu bao gồm nạp cơ sở dữ liệu địa lý có sẵn. Danh sách và JSON `status=all` đều chỉ có `alive` và khớp số lượng. Dừng tắt vòng lặp và xóa lịch tiếp theo. Trình duyệt với backend thật hiển thị 8 proxy, cấu hình 10.000/3 giây, 251 mục quốc gia (mọi/chưa xác định + 249 mã), không có cảnh báo/lỗi console. Kết quả proxy công khai phụ thuộc thời điểm đo; 100 ứng viên tải mới ở hai lượt này không có proxy mới nào qua được HTTPS.

Trong lần kiểm chứng luồng thủ công trước bản cập nhật tự động, trình duyệt với backend Python thật nhập danh sách đã bỏ loopback và bản trùng; bật tất cả cho kết quả 50 nguồn đang bật. Một lượt thu thập từ GcrawlAI thêm 100 proxy, kiểm tra lại một proxy cũ từng sống và xóa proxy cũ bị lỗi. Lượt Check sau đó đo đủ 102 địa chỉ, xóa 102 địa chỉ thất bại, kết thúc bình thường sau khoảng 3 giây.

Một phép thử mạng riêng lấy 45 proxy HTTP từng sống từ dữ liệu QA cũ, đo HTTPS thật với timeout 5 giây: **20 còn hoạt động, 25 thất bại được xóa**. Các proxy giữ lại có nhà mạng/server, ASN, quốc gia và `locationSource: "DB-IP Lite"`. Backend Node đo lại nhóm 20 này ở thời điểm sau: **18 hoạt động, 2 thất bại được xóa**. Đây là hai lượt đo vào hai thời điểm, không dùng làm phép so sánh tốc độ hay tỷ lệ sống giữa backend.

Giao diện thật đã hiển thị 20 kết quả cùng server/ASN/vị trí. Chọn Canada trả đúng một dòng; tệp JSON xuất theo Canada cũng có đúng một dòng và giữ thông tin server/vị trí. Console trình duyệt không ghi lỗi trong lượt xác minh.

Kết quả tải nguồn xác nhận có dữ liệu cú pháp hợp lệ cho HTTP, HTTPS, SOCKS4 và SOCKS5. Phép đo proxy công khai có kết quả sống nêu trên dùng HTTP CONNECT tới đích HTTPS; không suy ra rằng mọi nguồn hoặc mọi giao thức đều có proxy sống tại mọi thời điểm. Vị trí là ước tính của IP máy chủ; thành phố chỉ có khi nguồn cung cấp.

Chạy lại các phép thử theo [README](../README.md#kiểm-thử). Chạy lại phép rà nguồn sẽ tạo số lượng mới phụ thuộc trạng thái website tại thời điểm đó.
