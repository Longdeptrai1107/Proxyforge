import asyncio
import base64
import gzip
import json
import ssl
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit

from aiohttp.test_utils import TestClient, TestServer

from proxyforge.checker import check_proxy
from proxyforge.engine import ProxyEngine, SOURCES_FILE
from proxyforge.feeds import validate_feed_url
from proxyforge.parsing import parse_proxies, proxy_key, public_ip
from proxyforge.web import create_app
from proxyforge.geo import GeoLookup


class FakeGeo:
    warning = None

    async def prepare(self):
        pass

    def lookup(self, address):
        return {"countryCode": "US" if address == "8.8.8.8" else "VN",
                "server": "Test network", "asn": 64500}


class ParserTests(unittest.TestCase):
    def test_parse_and_deduplicate_protocol_ip_port(self):
        text = """# public examples
        8.8.8.8:8080
        http://8.8.8.8:8080
        socks5://1.1.1.1:1080
        socks4://[2606:4700:4700::1111]:4145
        127.0.0.1:8080
        192.168.1.1:8080
        user:pass@8.8.4.4:8080
        8.8.8.8:70000
        """
        parsed = parse_proxies(text)
        self.assertEqual(["http://8.8.8.8:8080", "socks5://1.1.1.1:1080",
                          "socks4://[2606:4700:4700::1111]:4145"], [proxy_key(p) for p in parsed])

    def test_json_and_html_sources(self):
        source = json.dumps({"data": [{"ip": "8.8.8.8", "port": 3128, "protocol": "http"},
                                       {"ip": "1.1.1.1", "port": 1080, "protocols": ["socks5"]}]})
        self.assertEqual(2, len(parse_proxies(source)))
        html = '<table><tr><td>8.8.8.8</td><td>8080</td></tr></table>'
        self.assertEqual("http://8.8.8.8:8080", proxy_key(parse_proxies(html)[0]))

    def test_obfuscated_proxy_website_formats(self):
        encoded_pair = base64.b64encode(b"8.8.8.8:8080").decode()
        encoded_ip = base64.b64encode(b"8.8.8.8").decode()
        encoded_reverse = base64.b64encode(b"0808:8.8.8.8").decode()
        html = """<script>Proxy('{}')</script>
        <table>
          <tr><td><script>document.write(atob('{}'))</script></td><td>8081</td></tr>
          <tr data-protos="HTTP|SOCKS5"><td>46.232.249.209:40001</td></tr>
          <tr><td><span>8.8.4.4</span><span>:8082</span></td><td>HTTP</td></tr>
          <tr data-p="{}"><td></td><td>HTTP</td></tr>
          <tr><td>1.1.1.1<script>document.write((y^x)+(y^x)+(y^x)+(w^z))</script></td><td>HTTP</td></tr>
        </table><script>x=9;y=9^x;z=2;w=0^z;</script>""".format(
            encoded_pair, encoded_ip, encoded_reverse)
        parsed = parse_proxies(html)
        keys = {proxy_key(proxy) for proxy in parsed}
        self.assertIn("http://8.8.8.8:8080", keys)
        self.assertIn("http://8.8.8.8:8081", keys)
        self.assertIn("http://8.8.4.4:8082", keys)
        self.assertIn("http://8.8.8.8:8080", keys)  # Reversed Base64 data attribute.
        self.assertIn("http://1.1.1.1:9990", keys)  # Restricted XOR port decoder.
        self.assertIn("socks5://46.232.249.209:40001", keys)

    def test_catalog_contains_fifty_independent_websites_and_four_protocols(self):
        sources = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
        domains = {urlsplit(source["url"]).hostname for source in sources}
        self.assertEqual(50, len(sources))
        self.assertEqual(50, len(domains))
        self.assertEqual(50, len({source["publisher"] for source in sources}))
        protocols = set()
        for source in sources:
            for feed in source.get("feeds") or [source]:
                self.assertNotIn("github", feed["url"].lower())
                self.assertTrue(feed["url"].startswith("https://"))
                protocols.add(feed["protocol"])
        self.assertEqual({"http", "https", "socks4", "socks5"}, protocols)

    def test_protocol_metadata_does_not_invent_http_duplicates(self):
        text = json.dumps({"proxies": [{"ip": "8.8.8.8", "port": 1080, "proxy": "8.8.8.8:1080",
                            "protocol": "socks5", "ip_data": {"countryCode": "VN", "city": "Hanoi",
                            "as": "AS7552 Viettel", "isp": "Viettel"}}]})
        parsed = parse_proxies(text)
        self.assertEqual(["socks5://8.8.8.8:1080"], [proxy_key(proxy) for proxy in parsed])
        self.assertEqual("VN", parsed[0]["countryCode"])
        self.assertEqual(7552, parsed[0]["asn"])
        self.assertEqual("Hanoi", parsed[0]["city"])
        self.assertEqual("Viettel", parsed[0]["server"])
        self.assertEqual("Viettel", parse_proxies(json.dumps(parsed))[0]["server"])
        html = '<tr><td>8.8.8.8:1080</td><td>SOCKS5</td></tr>'
        self.assertEqual(["socks5://8.8.8.8:1080"], [proxy_key(proxy) for proxy in parse_proxies(html)])
        self.assertEqual("https", parse_proxies('["https://8.8.8.8:443"]')[0]["protocol"])

    def test_provider_field_variants_and_documentation_examples(self):
        records = [{"ip_address": "8.8.8.8", "port": 1080, "protocol": "SOCKS5", "proxy": "8.8.8.8:1080"},
                   {"addr": "1.1.1.1", "port": 4145, "protocol": "socks4", "country_code": "DE"},
                   {"host": "9.9.9.9", "port": 3128, "proxy_type": "HTTP", "cc": "US"},
                   {"ip": "8.8.4.4", "port": 1081, "scheme": "socks5", "cc": "VN"}]
        parsed = parse_proxies(json.dumps({"proxies": records}))
        self.assertEqual(["socks5://8.8.8.8:1080", "socks4://1.1.1.1:4145", "http://9.9.9.9:3128", "socks5://8.8.4.4:1081"],
                         [proxy_key(proxy) for proxy in parsed])
        self.assertEqual("VN", parsed[-1]["countryCode"])
        html = ('<pre>http://1.2.3.4:8080</pre><code>socks5://1.2.3.4:1080</code>'
                '<script>self.__next_f.push([1,"example http://1.2.3.4:8080"])</script>'
                '<tr><td>8.8.8.8</td><td>8080</td></tr>')
        self.assertEqual(["http://8.8.8.8:8080"], [proxy_key(proxy) for proxy in parse_proxies(html)])
        codes = ",".join(str(ord(char) + 1) for char in "8.8.4.4")
        encoded = '<tr><td><script>[' + codes + '].map((n)=>String.fromCharCode(n-1)).join("")</script></td><td>8080</td></tr>'
        self.assertEqual(["http://8.8.4.4:8080"], [proxy_key(proxy) for proxy in parse_proxies(encoded)])

    def test_feed_security_and_public_ranges(self):
        self.assertTrue(public_ip("8.8.8.8"))
        for private in ("127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1"):
            self.assertFalse(public_ip(private), private)
        for url in ("http://8.8.8.8/list", "https://127.0.0.1/list",
                    "https://user:secret@example.com/list", "https://example.com:444/list"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_feed_url(url)
        self.assertEqual("https://example.com/feed", validate_feed_url("https://example.com/feed#fragment"))


class CheckerTests(unittest.IsolatedAsyncioTestCase):
    async def proxy_server(self, protocol, *, stall=False):
        async def handler(reader, writer):
            try:
                if stall:
                    await asyncio.sleep(2)
                elif protocol == "http":
                    await reader.readuntil(b"\r\n\r\n")
                    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    await writer.drain()
                    await asyncio.sleep(0.1)
                elif protocol == "socks5":
                    self.assertEqual(b"\x05\x01\x00", await reader.readexactly(3))
                    writer.write(b"\x05\x00"); await writer.drain()
                    header = await reader.readexactly(5)
                    address = await reader.readexactly(header[4] + 2)
                    self.assertEqual(3, header[3]); self.assertTrue(address)
                    writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00"); await writer.drain()
                    await asyncio.sleep(0.1)
                else:
                    header = await reader.readexactly(9)
                    self.assertEqual(b"\x04\x01", header[:2])
                    while await reader.readexactly(1) != b"\x00": pass
                    writer.write(b"\x00\x5a" + b"\x00" * 6); await writer.drain()
                    await asyncio.sleep(0.1)
            except (asyncio.IncompleteReadError, ConnectionError):
                pass
            finally:
                writer.close()
                try: await writer.wait_closed()
                except (ConnectionError, OSError): pass
        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        return server, server.sockets[0].getsockname()[1]

    async def test_http_socks5_socks4_handshakes(self):
        for protocol in ("http", "socks5", "socks4"):
            with self.subTest(protocol=protocol):
                server, port = await self.proxy_server(protocol)
                try:
                    proxy = {"host": "127.0.0.1", "port": port, "protocol": protocol}
                    result = await check_proxy(proxy, mode="handshake", timeout_ms=700,
                                               target_url="https://example.com", allow_private=True)
                    self.assertEqual("handshake", result["status"], result)
                    self.assertGreaterEqual(result["latencyMs"], 0)
                finally:
                    server.close(); await server.wait_closed()

    async def test_stalled_proxy_times_out(self):
        server, port = await self.proxy_server("http", stall=True)
        try:
            result = await check_proxy({"host": "127.0.0.1", "port": port, "protocol": "http"},
                                       mode="handshake", timeout_ms=100,
                                       target_url="https://example.com", allow_private=True)
            self.assertEqual("dead", result["status"])
            self.assertIn("Quá thời gian", result["error"])
        finally:
            server.close(); await server.wait_closed()


class GeoTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelling_a_lookup_does_not_start_overlapping_downloads(self):
        import threading
        started, release = threading.Event(), threading.Event()
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            geo = GeoLookup(temporary)
            def load():
                calls.append(True)
                started.set()
                release.wait(2)
                return {}, {}, []
            with patch.object(geo, "_load", side_effect=load):
                first = asyncio.create_task(geo.prepare())
                try:
                    self.assertTrue(await asyncio.to_thread(started.wait, 1))
                    first.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await first
                    second = asyncio.create_task(geo.prepare())
                    await asyncio.sleep(0)
                    self.assertEqual(1, len(calls))
                finally:
                    release.set()
                await second
                self.assertEqual(1, len(calls))

    async def test_cached_ipv4_ipv6_boundaries_and_country_overrides_asn_registration(self):
        with tempfile.TemporaryDirectory() as temporary:
            geo = GeoLookup(temporary)
            geo.directory.mkdir()
            rows = {"ip2asn-v4-u32.tsv.gz": "134744064\t134744319\t15169\tUS\tGoogle\n",
                    "ip2asn-v6.tsv.gz": "2606:4700::\t2606:4700::ffff\t13335\tUS\tCloudflare\n",
                    "dbip-country-lite-{}.csv.gz".format(datetime.now(timezone.utc).strftime("%Y-%m")):
                    '"8.8.8.0","8.8.8.255","VN"\n"2606:4700::","2606:4700::ffff","DE"\n'}
            for filename, text in rows.items():
                (geo.directory / filename).write_bytes(gzip.compress(text.encode()))
            with patch("proxyforge.geo.urlopen", side_effect=AssertionError("Unexpected network request")):
                await geo.prepare()
                await geo.prepare()
            self.assertIsNone(geo.warning)
            for address in ("8.8.8.0", "8.8.8.8", "8.8.8.255"):
                self.assertEqual("VN", geo.lookup(address)["countryCode"])
                self.assertEqual("Google", geo.lookup(address)["server"])
                self.assertEqual("DB-IP Lite", geo.lookup(address)["locationSource"])
            self.assertEqual("DE", geo.lookup("2606:4700::ffff")["countryCode"])
            self.assertIsNone(geo.lookup("8.8.9.0")["countryCode"])
            self.assertIsNone(geo.lookup("not an IP")["asn"])

    def test_corrupt_download_preserves_the_cached_database(self):
        import io
        import os
        with tempfile.TemporaryDirectory() as temporary:
            geo = GeoLookup(temporary)
            geo.directory.mkdir()
            path = geo.directory / "ip2asn-v4-u32.tsv.gz"
            original = gzip.compress(b"134744064\t134744319\t15169\tUS\tGoogle\n")
            path.write_bytes(original)
            os.utime(path, (0, 0))
            corrupted = gzip.compress(b"134744064\t134744319\t15169\tUS\tGoogle\nbad row\n")
            with patch("proxyforge.geo.urlopen", return_value=io.BytesIO(corrupted)):
                table = geo._cached(path, "https://example.com/data", lambda file: geo._read_asn(file, 4), 1)
            self.assertEqual(original, path.read_bytes())
            self.assertEqual("Google", table[2][0]["server"])


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_checker_failure_cancels_sibling_workers_and_preserves_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            started = asyncio.Event()
            settled = []
            async def checker(proxy, **kwargs):
                if proxy["host"] == "8.8.8.8":
                    await started.wait()
                    raise ValueError("checker failure")
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    settled.append(True)
            engine = ProxyEngine(temporary, sources=[], checker=checker, geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("8.8.8.8:8080\n1.1.1.1:8080"))
            for proxy in engine.proxies.values():
                proxy["status"] = "alive"
            engine.check(concurrency=2)
            await asyncio.wait_for(engine.task, 1)
            self.assertEqual("error", engine.job["state"])
            self.assertEqual([True], settled)
            self.assertEqual(0, engine.job["active"])
            self.assertEqual(2, len(engine.proxies))
            self.assertTrue(all(proxy["status"] != "checking" for proxy in engine.proxies.values()))

    async def test_geo_failure_and_stop_preserve_completed_network_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            class OfflineGeo(FakeGeo):
                async def prepare(self):
                    raise OSError("offline database")
            async def checker(proxy, **kwargs):
                return {"status": "alive"}
            engine = ProxyEngine(temporary, sources=[], checker=checker, geo=OfflineGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("8.8.8.8:8080"))
            engine.check()
            await engine.task
            self.assertEqual("done", engine.job["state"])
            self.assertEqual("offline database", engine.job["geoWarning"])
            locating = asyncio.Event()
            class PendingGeo(FakeGeo):
                async def prepare(self):
                    locating.set()
                    await asyncio.Event().wait()
            engine.geo = PendingGeo()
            engine.check()
            await asyncio.wait_for(locating.wait(), 1)
            await engine.stop()
            self.assertEqual("stopped", engine.job["state"])
            self.assertEqual(1, engine.snapshot()["counts"]["alive"])

    async def test_collect_all_protocols_rechecks_and_removes_stale_live_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            feeds = [{"url": "https://example.com/" + protocol, "protocol": protocol}
                     for protocol in ("http", "https", "socks4", "socks5")]
            source = {"id": "fixture", "publisher": "fixture", "url": feeds[0]["url"],
                      "protocol": "http", "enabled": True, "feeds": feeds}
            calls = []

            async def fetcher(session, url, **kwargs):
                return "8.8.8.8:1080"

            async def checker(proxy, **kwargs):
                calls.append(proxy["id"])
                return {"status": "dead" if proxy["host"] == "9.9.9.9" else "alive", "latencyMs": 10}

            engine = ProxyEngine(temporary, sources=[source], fetcher=fetcher, checker=checker, geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("9.9.9.9:8080"))
            old = next(iter(engine.proxies.values()))
            old.update(status="alive", checkedAt=datetime.now(timezone.utc).isoformat())
            engine.collect()
            await engine.task
            self.assertEqual(5, len(calls))
            self.assertIn("http://9.9.9.9:8080", calls)
            self.assertNotIn("http://9.9.9.9:8080", engine.proxies)
            self.assertEqual(1, engine.job["removed"])
            self.assertEqual({"http", "https", "socks4", "socks5"}, {p["protocol"] for p in engine.proxies.values()})
            self.assertEqual("done", engine.job["state"])

    async def test_check_always_measures_then_prunes_dead_and_persists_geo(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []

            async def checker(proxy, **kwargs):
                calls.append(proxy["id"])
                return {"status": "alive" if proxy["host"] == "8.8.8.8" else "dead",
                        "latencyMs": 10, "checkedAt": datetime.now(timezone.utc).isoformat()}

            engine = ProxyEngine(temporary, sources=[], checker=checker, geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("8.8.8.8:8080\n1.1.1.1:8080"))
            for item in engine.proxies.values():
                item.update(status="alive", checkMode="https", checkedAt=datetime.now(timezone.utc).isoformat())
            engine.check(use_cache=True)
            await engine.task
            self.assertEqual(2, len(calls))
            self.assertEqual(1, engine.job["removed"])
            self.assertEqual(1, engine.snapshot()["counts"]["alive"])
            self.assertEqual(1, engine.list_proxies(country="us")["total"])
            self.assertEqual(0, engine.list_proxies(country="VN")["total"])
            self.assertEqual(1, engine.list_proxies(search="Test network")["total"])
            restored = ProxyEngine(temporary, sources=[], auto_enabled=False)
            await restored.init()
            self.assertEqual(1, len(restored.proxies))
            self.assertEqual(64500, next(iter(restored.proxies.values()))["asn"])

    async def test_stopped_check_keeps_unchecked_old_live_and_releases_busy(self):
        with tempfile.TemporaryDirectory() as temporary:
            waiting = asyncio.Event()

            async def checker(proxy, **kwargs):
                if proxy["host"] == "8.8.8.8":
                    return {"status": "dead"}
                waiting.set()
                await asyncio.Event().wait()

            engine = ProxyEngine(temporary, sources=[], checker=checker, geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("8.8.8.8:8080\n1.1.1.1:8080"))
            for proxy in engine.proxies.values():
                proxy["status"] = "alive"
            engine.check(concurrency=1)
            await asyncio.wait_for(waiting.wait(), 1)
            await engine.stop()
            self.assertFalse(engine.busy)
            self.assertEqual("stopped", engine.job["state"])
            self.assertEqual(1, len(engine.proxies))
            self.assertEqual("1.1.1.1", engine.output_proxies()[0]["host"])
            self.assertTrue(all(proxy["status"] != "checking" for proxy in engine.proxies.values()))
            engine.check()
            await engine.stop()  # Also exercise cancellation before the task first runs.
            self.assertFalse(engine.busy)

    async def test_collect_force_recheck_import_and_persistence(self):
        with tempfile.TemporaryDirectory() as temporary:
            sources = [
                {"id": "one", "name": "one", "publisher": "sample", "protocol": "http",
                 "url": "https://feed-one.example/list", "enabled": True},
                {"id": "two", "name": "two", "publisher": "sample", "protocol": "http",
                 "url": "https://feed-two.example/list", "enabled": True},
            ]

            async def fake_feed(session, url, timeout_ms=12000):
                return "8.8.8.8:8080\n" if "one" in url else "8.8.8.8:8080\n1.1.1.1:8888\n"

            calls = []
            async def fake_checker(proxy, **kwargs):
                calls.append(proxy["id"])
                checked = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                return {"status": "alive", "latencyMs": 25, "checkedAt": checked,
                        "exitIP": "9.9.9.9", "error": None}

            engine = ProxyEngine(temporary, sources=sources, fetcher=fake_feed, checker=fake_checker, geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.collect(concurrency=2)
            await engine.task
            self.assertEqual(2, len(engine.proxies))
            self.assertEqual(1, engine.snapshot()["job"]["duplicates"])
            engine.check(concurrency=2, timeout_ms=1000)
            await engine.task
            self.assertEqual(2, engine.snapshot()["counts"]["alive"])
            self.assertEqual(4, len(calls))
            engine.check(concurrency=2, timeout_ms=1000)
            await engine.task
            self.assertEqual(0, engine.snapshot()["job"]["cached"])
            self.assertEqual(6, len(calls))
            self.assertEqual(1, engine.list_proxies(country="VN")["total"])
            self.assertEqual("Test network", engine.list_proxies(country="US")["rows"][0]["server"])
            import_result = await engine.import_proxies("http://9.9.9.9:8000\n", "http")
            await engine.task
            self.assertEqual(1, import_result["added"])
            await engine.save()
            restored = ProxyEngine(temporary, sources=sources, auto_enabled=False)
            await restored.init()
            self.assertEqual(3, restored.snapshot()["counts"]["total"])


class WebTests(unittest.IsolatedAsyncioTestCase):
    async def test_country_catalog_filters_and_export_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine = ProxyEngine(temporary, sources=[], auto_enabled=False)
            await engine.init()
            engine.add_proxies([{"host": "8.8.8.8", "port": 8080, "protocol": "http", "countryCode": "VN",
                                 "city": "Hanoi", "server": "Test ISP", "asn": 64500},
                                {"host": "1.1.1.1", "port": 1080, "protocol": "socks5", "countryCode": "US"}])
            for proxy in engine.proxies.values():
                proxy["status"] = "alive"
            client = TestClient(TestServer(create_app(engine)))
            await client.start_server()
            try:
                countries = await (await client.get("/countries.json")).json()
                self.assertEqual(249, len(set(countries)))
                self.assertIn("VN", countries)
                rows = await (await client.get("/api/proxies?country=VN")).json()
                self.assertEqual(1, rows["total"])
                self.assertEqual("Test ISP", rows["rows"][0]["server"])
                exported = await (await client.get("/api/export?format=json&status=all&country=VN")).json()
                self.assertEqual(1, len(exported))
                self.assertEqual("Hanoi", exported[0]["city"])
                csv_response = await client.get("/api/export?format=csv&status=all&country=VN")
                self.assertIn('"Test ISP","64500"', await csv_response.text())
            finally:
                await client.close()
    async def test_json_export_is_valid_for_empty_single_and_multiple_batches(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine = ProxyEngine(temporary, sources=[], auto_enabled=False)
            client = TestClient(TestServer(create_app(engine)))
            await client.start_server()
            try:
                for count in (0, 1, 2, 501):
                    with self.subTest(count=count):
                        engine.add_proxies([{"host": "8.8.8.8", "port": 8000 + index,
                                             "protocol": "http"} for index in range(count)])
                        for proxy in engine.proxies.values():
                            proxy["status"] = "alive"
                        response = await client.get("/api/export?format=json&status=all")
                        self.assertEqual(200, response.status)
                        self.assertIn("attachment", response.headers["Content-Disposition"])
                        exported = await response.json()
                        self.assertEqual(count, len(exported))
                        self.assertEqual(list(engine.proxies), [row["id"] for row in exported])
            finally:
                await client.close()

    async def test_static_state_csrf_and_safe_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine = ProxyEngine(temporary, sources=[], auto_enabled=False)
            app = create_app(engine, token="known-test-token")
            client = TestClient(TestServer(app))
            await client.start_server()
            try:
                page = await client.get("/")
                self.assertEqual(200, page.status)
                state_response = await client.get("/api/state")
                state = await state_response.json()
                self.assertEqual("known-test-token", state["token"])
                blocked = await client.post("/api/import", json={"text": "8.8.8.8:8080"})
                self.assertEqual(403, blocked.status)
                allowed = await client.post("/api/import", headers={"X-Proxy-Forge-Token": state["token"]},
                                            json={"text": "8.8.8.8:8080\n127.0.0.1:8080"})
                self.assertEqual(200, allowed.status)
                result = await allowed.json()
                self.assertEqual(1, result["added"])
            finally:
                await client.close()


if __name__ == "__main__":
    unittest.main()
