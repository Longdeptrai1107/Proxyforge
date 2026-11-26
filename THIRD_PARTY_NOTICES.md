# Thành phần bên thứ ba

Source này kèm bốn JAR nhỏ trong `lib/` để build lại trên JDK 17+. JDK được cài riêng, không nằm trong source hoặc bản phát hành.

| Thành phần | Vai trò | Giấy phép / nguồn |
|---|---|---|
| Eclipse ECJ 3.33.0 | Compiler source 1.3, classfile 45.3; chỉ dùng khi build | [EPL 2.0](https://www.eclipse.org/legal/epl-2.0/); [Maven Central](https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.33.0/), thông báo gốc trong `about.html` của JAR |
| MicroEmulator 2.0.4 | Runtime MIDP/CLDC, Swing; được ghép vào `QLTK.jar` | Header source cấp lựa chọn LGPL 2.1+ hoặc Apache 2.0; [binary và source gốc](https://repo.maven.apache.org/maven2/org/microemu/microemulator/2.0.4/) |
| cldcapi11 / midpapi20 2.0.4 | API compile-only; không ghép vào JAR game | Thành phần MicroEmulator; [Maven Central](https://repo.maven.apache.org/maven2/org/microemu/) |

Source MicroEmulator nguyên bản nằm trong `lib/microemulator-2.0.4-sources.jar`; bản sao tương ứng được cung cấp trong Releases. Các class MicroEmulator giữ nguyên bytecode gốc. `account-manager/qltk/net/` là adapter bổ sung qua `ImplFactory.registerGCF`; không thay class socket của thư viện. `PackageManager.java` giữ nguyên tài nguyên thư viện, chỉ thay manifest chính và bỏ chữ ký JAR khi ghép gói. Có thể thay phiên bản thư viện trong `lib/` rồi build lại QLTK bằng source đi kèm; khi thay phiên bản cần kiểm tra tương thích API.

Văn bản giấy phép thư viện nằm trong `LICENSES/` và được kèm trong `QLTK.jar`. Copyright và header giấy phép gốc được giữ trong source thư viện. Giấy phép thư viện áp dụng riêng, không tự cấp quyền đối với game, thương hiệu, hình ảnh hoặc tài nguyên game. Xem [LICENSE.md](LICENSE.md) về tình trạng giấy phép chung của nội dung game.
