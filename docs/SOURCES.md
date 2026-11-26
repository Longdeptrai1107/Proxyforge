# 50 website/API nguồn của Proxy Forge

Danh mục dùng chung cho Python và Node: [sources.json](../proxyforge/sources.json). Mỗi dòng là một website/nhà cung cấp; các endpoint giao thức của cùng nhà cung cấp được gộp lại. Danh sách không dùng GitHub raw hay CDN mirror GitHub. Một số nhà cung cấp tổng hợp chung các feed công khai, nên địa chỉ giữa các nguồn có thể trùng nhau.

Lượt rà **26/11/2026** tải và đọc được **50/50 nguồn**: 67.884 bản ghi cộng theo nguồn, trước khi loại trùng giữa nguồn. HTTP: 22.187; HTTPS: 9.034; SOCKS4: 14.569; SOCKS5: 22.094. Xem thời điểm, URL, số lượng và lỗi từng endpoint trong [source-audit.json](source-audit.json). Số lượng thay đổi theo thời gian; các số này không phải số proxy đã đo sống.

| # | Nhà cung cấp | Trang danh sách / tài liệu |
| --- | --- | --- |
| 1 | ProxyScrape | [proxyscrape.com](https://proxyscrape.com/free-proxy-list) |
| 2 | Geonode | [geonode.com](https://geonode.com/free-proxy-list) |
| 3 | HProxy | [hproxy.com](https://hproxy.com/) |
| 4 | OpenProxyList | [openproxylist.xyz](https://openproxylist.xyz/) |
| 5 | Free-Proxy-List.net | [free-proxy-list.net](https://free-proxy-list.net/) |
| 6 | ProxyDB | [proxydb.net](https://proxydb.net/) |
| 7 | FreeProxyWorld | [freeproxy.world](https://www.freeproxy.world/) |
| 8 | ProxyListPlus | [proxylistplus.com](https://www.proxylistplus.com/) |
| 9 | My-Proxy | [my-proxy.com](https://www.my-proxy.com/) |
| 10 | ProxyNova | [proxynova.com](https://www.proxynova.com/proxy-server-list/) |
| 11 | Proxy-List.org | [proxy-list.org](https://proxy-list.org/english/index.php) |
| 12 | Spys.one | [spys.one](https://spys.one/) |
| 13 | ProxyVerity | [proxyverity.com](https://proxyverity.com/) |
| 14 | ProxyElite | [proxyelite.info](https://proxyelite.info/free-proxy-list/) |
| 15 | ProxyLister | [proxylister.com](https://proxylister.com/) |
| 16 | ProxyFreeOnly | [proxyfreeonly.com](https://proxyfreeonly.com/) |
| 17 | Proxy11 | [proxy11.com](https://proxy11.com/) |
| 18 | HideMy.name | [hide.mn](https://hide.mn/en/proxy-list/) |
| 19 | FineProxy | [fineproxy.org](https://fineproxy.org/free-proxy/) |
| 20 | ProxyMania | [proxymania.su](https://proxymania.su/free-proxy) |
| 21 | Proxmint | [proxmint.com](https://proxmint.com/free-proxies) |
| 22 | Scrappey | [scrappey.com](https://scrappey.com/tools/free-proxy-lists) |
| 23 | Proxora | [proxora.io](https://proxora.io/free-proxy-list/api) |
| 24 | NodeMaven | [nodemaven.com](https://nodemaven.com/free-proxy-list) |
| 25 | FlashProxy | [flashproxy.com](https://flashproxy.com/resources/free-proxies) |
| 26 | ProxyCompass | [proxycompass.com](https://www.proxycompass.com/free-proxy/) |
| 27 | Advanced.name | [advanced.name](https://advanced.name/freeproxy) |
| 28 | ProxySpace | [proxyspace.pro](https://proxyspace.pro/) |
| 29 | ProxyHub | [proxyhub.me](https://www.proxyhub.me/) |
| 30 | Proxy-Daily | [proxy-daily.com](https://proxy-daily.com/) |
| 31 | Proxiware | [proxiware.com](https://proxiware.com/free-proxy-list) |
| 32 | FreeProxyAPI | [freeproxyapi.com](https://www.freeproxyapi.com/) |
| 33 | ProxyTee | [proxytee.com](https://proxytee.com/free-proxies) |
| 34 | myProxyChecker | [myproxychecker.com](https://myproxychecker.com/api/proxy-list) |
| 35 | ROLA-IP | [rola-ip.co](https://rola-ip.co/tools/free-proxy-list/) |
| 36 | Databay | [databay.com](https://databay.com/free-proxy-list) |
| 37 | Proxy-Free.com | [proxy-free.com](https://proxy-free.com/) |
| 38 | WE1.Town | [we1.town](https://we1.town/en/free-proxy-list) |
| 39 | Ihuan | [ip.ihuan.me](https://ip.ihuan.me/) |
| 40 | 89IP | [89ip.cn](https://www.89ip.cn/) |
| 41 | RoundProxies | [roundproxies.com](https://roundproxies.com/free-proxy-list) |
| 42 | CleanProxies | [cleanproxies.com](https://cleanproxies.com/tools/free-proxy-list) |
| 43 | Litport | [litport.net](https://litport.net/docs/free-proxy-api) |
| 44 | Way2Proxy | [way2proxy.com](https://way2proxy.com/free-proxy-list) |
| 45 | GcrawlAI | [gcrawlai.com](https://gcrawlai.com/free-proxy-list) |
| 46 | ProxyScraper | [proxyscraper.com](https://proxyscraper.com/) |
| 47 | Proxio | [proxio.io](https://proxio.io/) |
| 48 | MarsProxies | [marsproxies.com](https://marsproxies.com/free-proxy-list) |
| 49 | Dahono | [router.dahono.com](https://router.dahono.com/proxy/free) |
| 50 | GimmeProxy | [gimmeproxy.com](https://gimmeproxy.com/) |

Một số API trả một trang hoặc một tập con của danh sách. Nguồn có thể tạm lỗi, giới hạn truy cập hoặc thay đổi định dạng. Chạy lại phép rà với:

```powershell
.\.venv\Scripts\python.exe .\scripts\audit-sources.py --output .\docs\source-audit.json
```

**Thu thập** đưa proxy mới vào trạng thái chờ và đo lại các proxy cũ từng sống. **Kiểm tra ngay** xác minh các proxy đã chọn trên kết nối của máy đang chạy rồi xóa proxy thất bại sau khi đo xong.
