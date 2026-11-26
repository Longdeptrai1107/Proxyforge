# Source QLTK NRI

Project Eclipse **NRO-JavaME** chứa 158 tệp Java game, 488 resource và các thư viện để build/chạy/debug, cùng trình quản lý tài khoản Windows. Đây là bản đã sửa lỗi Start và vùng repaint trong MicroEmulator; không chứa source decompile cũ, DLL, bản gốc hoặc dữ liệu phân tích.

Tải **`QLTK.jar`** ở [GitHub Releases](https://github.com/Longdeptrai1107/Source-QLTK-NRI/releases/latest). Chạy trên Windows với Java 17 trở lên. Source không kèm JDK hoặc dữ liệu tài khoản cá nhân; thư viện build nhỏ nằm trong `lib/` để có thể build lại ngay.

## Proxy và tiết kiệm tài nguyên

Mỗi tài khoản có cấu hình riêng, không dùng chung proxy giữa các cửa sổ game:

| Trường | Cách nhập |
|---|---|
| Kết nối | `DIRECT` để kết nối trực tiếp, `SOCKS5` hoặc `HTTP` để dùng HTTP CONNECT |
| Host proxy | IP/tên miền, ví dụ `127.0.0.1`; không nhập tiền tố `http://` |
| Cổng proxy | Số từ 1 đến 65535 do nhà cung cấp proxy cấp |
| Tài khoản / mật khẩu proxy | Để trống nếu proxy không yêu cầu xác thực; SOCKS5 hỗ trợ username/password, HTTP hỗ trợ Basic |
| RAM tối đa / game | 96 MB, **128 MB mặc định**, hoặc 256 MB cho phiên cần thêm bộ nhớ |

Nhập proxy cùng tài khoản rồi bấm **Thêm tài khoản** hoặc **Lưu thay đổi**. Khi sửa, để trống mật khẩu để giữ mật khẩu đã lưu; chọn `DIRECT` và lưu để bỏ proxy. Tài khoản cũ tự dùng `DIRECT` và 128 MB, không cần nhập lại.

Proxy chuyển tiếp socket TCP của game, gồm cả tải tài nguyên qua giao thức game. Tên miền đích SOCKS5 được gửi cho proxy phân giải. HTTP proxy phải cho phép `CONNECT` tới cổng game (có nhà cung cấp chỉ mở cổng 443). Khi proxy lỗi, QLTK báo **Lỗi proxy** và không tự chuyển sang kết nối trực tiếp. Mật khẩu proxy được bảo vệ bằng Windows DPAPI và truyền qua stdin tới JVM con, tương tự mật khẩu game. Website được mở bằng trình duyệt ngoài dùng cấu hình mạng của trình duyệt đó.

Mỗi JVM game bắt đầu với heap 16 MB, dùng Serial GC và bộ đệm mã máy tối đa 32 MB; giới hạn heap mặc định giảm từ 512 xuống 128 MB. Đây là giới hạn heap Java, **không phải tổng RAM của tiến trình**: JVM, luồng và giao diện còn có bộ nhớ riêng. Chế độ 96 MB phù hợp để thử mở nhiều cửa sổ; nếu phiên thiếu heap hãy chọn 128 hoặc 256 MB.

Luồng gửi dữ liệu dùng `wait/notify` khi rảnh thay cho việc thức dậy mỗi 10 ms. Cửa sổ đang thao tác giữ nhịp vẽ gốc khoảng 37 FPS; cửa sổ mất focus vẽ tối đa 5 FPS, thu nhỏ thì ngừng vẽ. Logic game vẫn cập nhật theo nhịp gốc 27 ms và luồng mạng vẫn chạy. JVM con bỏ qua các lệnh ép `System.gc()` của game để tránh dừng hình do gọi GC thủ công; bộ gom rác vẫn tự hoạt động khi cần. Hiệu năng thực tế phụ thuộc số cửa sổ, cấu hình máy, bản đồ và độ trễ proxy/server.

## Quản lý tài khoản

Phần mềm được đóng gói thành **một file `QLTK.jar` duy nhất**, chứa giao diện Java Swing, MicroEmulator và JAR/JAD game đã sửa. File ở thư mục gốc và bản sao trong `release/` đã được cập nhật cùng bản sửa. Đóng trình quản lý cũ và mở lại các cửa sổ game để nhận source mới; tài khoản đã lưu được giữ nguyên. Có thể chép riêng file JAR sang thư mục khác hoặc máy Windows khác có Java 17+ rồi chạy:

```powershell
java -jar .\QLTK.jar
```

Có thể bấm đúp `QLTK.jar` nếu Windows đã liên kết `.jar` với Java. `QuanLyTaiKhoan.cmd` chỉ là lối mở tiện dụng trong thư mục source, không bắt buộc khi sử dụng bản JAR.

1. Nhập tài khoản, mật khẩu, chọn server và nhập ghi chú, rồi bấm **Thêm tài khoản**.
2. Chọn proxy và mức RAM nếu cần. Bấm một dòng trong bảng để mở game; có thể chọn dòng bằng bàn phím rồi bấm **Chạy đã chọn** hoặc Enter.
3. Mỗi tài khoản mở một MicroEmulator riêng ở chế độ **Resizable**, vùng game ban đầu **240 × 320**. Luồng nền khởi động và theo dõi tiến trình giúp giao diện quản lý tiếp tục phản hồi.
4. Trình quản lý truyền tài khoản/mật khẩu/server và mã phiên riêng qua stdin của tiến trình Java con. Bootstrap tìm MIDlet đang chạy, lấy đúng classloader của game và gọi `AccountAutomation.bindSession(...)` trong JAR game. Game xác nhận lại mã phiên, từ chối gắn đè tài khoản của một phiên đã có tài khoản.
   Trong vòng cập nhật đầu tiên sau khi nhận tài khoản, code game ghi TK/MK vào RMS, điền ô đăng nhập và đặt server, IP, port trước khi chờ mạng. Khi đã ghi xong game phát trạng thái **Đã ghi tài khoản, mật khẩu và server vào game**. Việc nạp lại danh sách server và tạo lại màn hình Login không được xóa hoặc chuyển những thông tin này về mặc định. Kết nối server thất bại vẫn giữ thông tin đã điền.
5. Khi game hiện yêu cầu tải dữ liệu, chức năng tự động gọi chính lệnh của nút **Tải dữ liệu**. Sau khi game xác nhận dữ liệu sẵn sàng, tự gọi **Chơi tài khoản** (`ServerListScreen.perform(3, null)`), đi qua `Login_New()` và `LoginScr.doLogin()` bằng TK/MK của phiên. Nếu game xác nhận dữ liệu đã có đúng phiên bản, bỏ qua tải và thực hiện luôn bước Chơi tài khoản. Không cần bấm tiếp bằng tay. Việc đóng kết nối phụ chỉ xóa trạng thái của kết nối phụ, giữ nguyên xác nhận dữ liệu của kết nối chính.
6. Dùng **Dừng đã chọn** để đóng game. Muốn sửa tài khoản đang chạy, hãy dừng trước, sửa các ô rồi bấm **Lưu thay đổi**. Để trống ô mật khẩu khi sửa để giữ mật khẩu cũ. Nút **Xóa** có hỏi xác nhận.

Trạng thái **Đã gửi đăng nhập** xác nhận lệnh đã được gửi; thông báo tài khoản sai, bảo trì hoặc lỗi mạng hiển thị trong game. Tự động hóa dừng sau 3 phút nếu chưa gửi đăng nhập; người dùng có thể thao tác trực tiếp trong game. Không tự bấm xác nhận các hộp thoại lỗi hoặc thử đăng nhập liên tục.

Tài khoản lưu tại `%LOCALAPPDATA%\NroAccountManager\accounts-java.xml`, có bản sao `.bak` khi cập nhật. Nếu có dữ liệu từ bản EXE trước đây (`accounts.xml`), bản Java tự nhập một lần khi chưa có tệp Java; tệp cũ được giữ nguyên. Mật khẩu được mã hóa bằng Windows DPAPI qua PowerShell có sẵn trên Windows, được che trong bảng và truyền sang phiên game qua stdin. Không chuyển tệp tài khoản sang người dùng Windows khác để giải mã.

Lần chạy đầu, chương trình tự giải nén JAR/JAD game đi kèm vào `%LOCALAPPDATA%\NroAccountManager\runtime\`; người dùng không cần chép thêm thư viện hay JAR game bên cạnh `QLTK.jar`. Dữ liệu game/RMS hiện nằm trong bộ nhớ riêng từng tiến trình, vì vậy lần mở game mới có thể cần tải lại dữ liệu. Đóng trình quản lý vẫn để các cửa sổ game đang mở tiếp tục chạy; đóng cửa sổ MicroEmulator để thoát game đó.

Build lại cả game và phần mềm sau khi sửa source hoặc chuyển máy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-manager.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-manager.ps1
```

Máy chạy cần Windows và Java 17+. Máy build cần JDK 17+; có thể truyền `-JavaHome` cho script build. Không cần EXE quản lý hay .NET compiler để build bản Java. Bộ kiểm tra gồm lưu/đọc tài khoản Unicode, DPAPI, ghi tệp có bản sao, bảng Swing, kiểm tra trạng thái tự động và hai phiên MicroEmulator chạy đồng thời qua splash thật với socket bị chặn. Sau splash, bài kiểm tra đọc trực tiếp các ô TK/MK, RMS, server, IP và port của game mà không tự điền trước; kiểm tra thêm trường hợp tạo lại LoginScr, nút Login thật và canvas 240 × 320. Bài kiểm tra nút Login chặn listener trước khi gửi mạng, không gửi thông tin thử lên server. Bộ kiểm tra không xác nhận đăng nhập thành công với tài khoản trên máy chủ thật.

Kiểm tra toàn luồng `java -jar QLTK.jar --flow-test` sử dụng máy chủ thử nghiệm TCP trên loopback: bấm nút Thêm, phát sự kiện chuột lên dòng tài khoản của bảng Swing, mở MicroEmulator thật, bắt tay socket, trả lời yêu cầu cập nhật và đọc gói đăng nhập do game gửi. Hai trường hợp bắt buộc tải dữ liệu và dữ liệu đã sẵn sàng đều phải gửi đúng TK/MK sau bước Chơi tài khoản. Không dùng máy chủ công cộng hoặc thông tin tài khoản thật trong bài kiểm tra này.

`test-manager.ps1` còn chạy các proxy SOCKS5/HTTP thật trên loopback, có/không xác thực: kiểm tra DNS phía proxy, giữ nguyên byte đầu của game, lỗi bắt tay không kết nối trực tiếp, lưu mật khẩu proxy bằng DPAPI và bốn luồng UI → JVM → proxy → đăng nhập với heap 96 MB.

Bài kiểm tra tài nguyên xác nhận chỉ có một luồng canvas, sender ngủ/chạy lại/dừng đúng khi có gói tin hoặc đóng phiên, và thu nhỏ cửa sổ ngừng vẽ nhưng nhịp cập nhật game vẫn tiếp tục. Số đo heap/CPU của một cửa sổ trong cảnh thử được ghi vào `.build/runtime-resource-test.json`; đây không phải benchmark trên bản đồ đông người hoặc bảo đảm mức RAM/CPU cho mọi phiên.

## Build

Cần **JDK 17**. Script ưu tiên `toolchain/java`, sau đó `JAVA_HOME` hoặc `java` trong PATH. ZIP source nhẹ không kèm JDK; trên máy khác hãy cài JDK 17 và đặt `JAVA_HOME`, hoặc truyền `-JavaHome`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

JAR/JAD mới nằm trong `dist/`. Bản debug có thông tin biến cục bộ nằm trong `debug-dist/`. Compiler vẫn sinh classfile 45.3, boot API CLDC 1.1/MIDP 2.0.

## Eclipse và debug

1. File → Import → General → Existing Projects into Workspace; chọn thư mục này và import **NRO-JavaME**. Dùng workspace Eclipse riêng nếu muốn làm việc tách biệt.
2. Project → Build Project để build bằng external builder đã có.
3. Đặt breakpoint tại `main.GameMidlet.startApp()` hoặc `nro.MotherCanvas`.
4. Chạy lệnh bên dưới. JVM sẽ chờ debugger, nên emulator chưa xuất hiện ngay.
5. Trong Eclipse: Run → Debug Configurations → Remote Java Application. Chọn project **NRO-JavaME**, Host **127.0.0.1**, Port **5005**, rồi Debug và Resume (F8).
6. Khi MicroEmulator mở, chọn game và bấm Start.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Debug
```

Đổi cổng bằng `-Port 5006`; chỉ build debug bằng `build.ps1 -DebugSymbols`. Biến đã bị compiler tối ưu bỏ có thể không còn để xem trong debugger.

`src/main/java/` là source game, `src/main/resources/` là tài nguyên, `account-manager/` là QLTK Swing và bootstrap, `account-manager/qltk/net/` là adapter proxy, `lib/` là ECJ/API/MicroEmulator và `toolchain/StandaloneJarBuild.java` là công cụ build. ZIP source chỉ chứa project và phụ thuộc build nhỏ; không chứa JDK, cache hoặc dữ liệu cá nhân. Script build cập nhật cả `QLTK.jar` và `release/QLTK.jar`.

Đóng gói source nhỏ để chép sang máy khác: `powershell -NoProfile -ExecutionPolicy Bypass -File .\package-source.ps1`. Tệp tạo ở `release/nro-qltk-java-source.zip`.
