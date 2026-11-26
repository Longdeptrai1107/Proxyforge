import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from proxyforge.engine import ProxyEngine
from proxyforge.parsing import parse_proxies
from proxyforge.web import create_app
from test_proxyforge import FakeGeo


SOURCE = {"id": "fixture", "publisher": "fixture", "name": "fixture", "enabled": True,
          "url": "https://example.com/list", "protocol": "http"}


class AutomationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_during_persistence_saves_disabled_state_after_interrupted_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine = ProxyEngine(temporary, sources=[SOURCE], geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.automation["enabled"] = True
            started, release = threading.Event(), threading.Event()
            original = Path.write_text
            writes = []

            def slow_write(path, *args, **kwargs):
                if path == engine.state_path.with_suffix(".tmp"):
                    writes.append(True)
                    if len(writes) == 1:
                        started.set()
                        release.wait(2)
                return original(path, *args, **kwargs)

            with patch.object(Path, "write_text", slow_write):
                saving = asyncio.create_task(engine.save())
                try:
                    self.assertTrue(await asyncio.to_thread(started.wait, 1))
                    saving.cancel()
                    stopping = asyncio.create_task(engine.stop())
                    await asyncio.sleep(0)
                    self.assertFalse(stopping.done())
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await saving
                await stopping
            saved = json.loads(engine.state_path.read_text(encoding="utf-8"))
            self.assertFalse(saved["automation"]["enabled"])
            self.assertIsNone(engine._warning)

    async def test_refresh_publishes_only_https_successes_and_keeps_old_live_during_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            started, release = asyncio.Event(), asyncio.Event()
            calls = []

            async def fetcher(session, url, **kwargs):
                calls.append(url)
                return "8.8.8.8:8080\n1.1.1.1:8080"

            async def checker(proxy, **kwargs):
                self.assertEqual({"mode": "https", "timeout_ms": 3000}, kwargs)
                if proxy["host"] == "9.9.9.9":
                    started.set()
                    await release.wait()
                    return {"status": "dead"}
                return {"status": "alive" if proxy["host"] == "8.8.8.8" else "handshake", "latencyMs": 10}

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker,
                                 geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("9.9.9.9:8080"))
            engine.proxies["http://9.9.9.9:8080"]["status"] = "alive"
            engine.cache[SOURCE["url"]] = {"time": 10**20, "text": "8.8.4.4:9090"}
            engine.refresh()
            try:
                await asyncio.wait_for(started.wait(), 1)
                await asyncio.sleep(0)
                self.assertEqual({"9.9.9.9", "8.8.8.8"}, {p["host"] for p in engine.output_proxies()})
                self.assertTrue(all(p["status"] == "alive" for p in engine.list_proxies()["rows"]))
            finally:
                release.set()
                await engine.task
            self.assertEqual([SOURCE["url"]], calls)
            self.assertEqual(["8.8.8.8"], [p["host"] for p in engine.output_proxies()])
            self.assertEqual(1, engine.job["removed"])
            self.assertEqual(1, engine.job["liveAdded"])
            saved = json.loads(Path(temporary, "state.json").read_text(encoding="utf-8"))
            self.assertEqual(["alive"], [p["status"] for p in saved["proxies"]])
            self.assertEqual(10000, engine.job["options"]["concurrency"])

    async def test_auto_repeats_without_overlap_and_resumes_on_backend_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
            fetches, active, maximum = [], 0, 0

            async def fetcher(session, url, **kwargs):
                fetches.append(url)
                return "8.8.8.8:8080"

            async def checker(proxy, **kwargs):
                nonlocal active, maximum
                active += 1
                maximum = max(maximum, active)
                try:
                    if len(fetches) == 1:
                        first.set()
                        await release.wait()
                    else:
                        second.set()
                    return {"status": "alive", "latencyMs": 1}
                finally:
                    active -= 1

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker,
                                 geo=FakeGeo(), auto_interval_ms=40)
            await engine.init()
            try:
                await asyncio.wait_for(first.wait(), 1)
                await asyncio.sleep(0.09)
                self.assertEqual(1, len(fetches), "A long round must finish before starting another")
                release.set()
                await asyncio.wait_for(second.wait(), 1)
                await engine.stop()
                self.assertEqual(1, maximum)
                self.assertFalse(engine.automation["enabled"])
                self.assertIsNone(engine.automation["nextRunAtMs"])
                self.assertFalse(engine.busy)
                count = len(fetches)
                await asyncio.sleep(0.09)
                self.assertEqual(count, len(fetches))
                restarted = asyncio.Event()

                async def restart_checker(proxy, **kwargs):
                    restarted.set()
                    return {"status": "alive", "latencyMs": 1}

                restored = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher,
                                       checker=restart_checker, geo=FakeGeo())
                await restored.init()
                try:
                    await asyncio.wait_for(restarted.wait(), 1)
                    self.assertTrue(restored.automation["enabled"])
                    self.assertTrue(restored.live_only)
                    self.assertIsNotNone(restored._auto_task)
                finally:
                    await restored.close()
                await engine.configure_auto()
                self.assertTrue(engine.automation["enabled"])
                await asyncio.sleep(0)
                await engine.stop()
            finally:
                release.set()
                await engine.close()

    async def test_web_startup_runs_without_any_browser_request_or_start_button(self):
        with tempfile.TemporaryDirectory() as temporary:
            Path(temporary, "state.json").write_text(json.dumps({"automation": {"enabled": False}}), encoding="utf-8")
            checking = asyncio.Event()

            async def fetcher(session, url, **kwargs):
                return "8.8.8.8:8080"

            async def checker(proxy, **kwargs):
                self.assertEqual({"mode": "https", "timeout_ms": 3000}, kwargs)
                checking.set()
                return {"status": "alive", "latencyMs": 1}

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker, geo=FakeGeo())
            server = TestServer(create_app(engine))
            await server.start_server()
            try:
                # No GET /api/state, POST /api/auto or UI is used to start the job.
                await asyncio.wait_for(checking.wait(), 1)
                await engine.task
                self.assertTrue(engine.automation["enabled"])
                self.assertEqual(60000, engine.automation["intervalMs"])
                self.assertEqual(10000, engine.job["options"]["concurrency"])
                self.assertEqual(1, engine.snapshot()["counts"]["alive"])
            finally:
                await server.close()

    async def test_stop_during_refresh_keeps_verified_partial_output_and_unchecked_old_live(self):
        with tempfile.TemporaryDirectory() as temporary:
            started = asyncio.Event()

            async def fetcher(session, url, **kwargs):
                return "8.8.8.8:8080\n1.1.1.1:8080"

            async def checker(proxy, **kwargs):
                if proxy["host"] == "9.9.9.9":
                    return {"status": "dead"}
                if proxy["host"] == "8.8.8.8":
                    return {"status": "alive", "latencyMs": 1}
                started.set()
                await asyncio.Event().wait()

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker,
                                 geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.add_proxies(parse_proxies("9.9.9.9:8080\n8.8.8.8:8080\n1.1.1.1:8080"))
            for proxy in engine.proxies.values():
                proxy["status"] = "alive"
            engine.refresh(concurrency=1)
            await asyncio.wait_for(started.wait(), 1)
            await engine.stop()
            self.assertEqual("stopped", engine.job["state"])
            self.assertEqual({"8.8.8.8", "1.1.1.1"}, {p["host"] for p in engine.output_proxies()})
            self.assertTrue(all(p["status"] == "alive" for p in engine.output_proxies()))
            self.assertEqual(1, engine.job["removed"])

    async def test_ten_thousand_checks_run_concurrently_and_pending_work_waits(self):
        # Use a gate to count simultaneous probes independently of machine socket limits.
        asyncio.get_running_loop().set_debug(False)
        with tempfile.TemporaryDirectory() as temporary:
            ready, release = asyncio.Event(), asyncio.Event()
            active, maximum, calls = 0, 0, 0

            async def fetcher(session, url, **kwargs):
                return "\n".join("8.8.8.8:{}".format(port) for port in range(10000, 20001))

            async def checker(proxy, **kwargs):
                nonlocal active, maximum, calls
                self.assertEqual({"mode": "https", "timeout_ms": 3000}, kwargs)
                active += 1
                calls += 1
                maximum = max(maximum, active)
                if active == 10000:
                    ready.set()
                try:
                    await release.wait()
                    return {"status": "dead"}
                finally:
                    active -= 1

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker,
                                 geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.refresh(concurrency=10000)
            try:
                await asyncio.wait_for(ready.wait(), 5)
                self.assertEqual(10000, active)
                self.assertEqual(10000, calls)
                self.assertEqual(10000, engine.snapshot()["limits"]["maxConcurrency"])
            finally:
                release.set()
                await engine.task
            self.assertEqual(10000, maximum)
            self.assertEqual(10001, engine.job["networkChecked"])
            self.assertEqual(0, engine.snapshot()["counts"]["total"])

    async def test_api_auto_and_import_only_export_verified_live_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            started, release = asyncio.Event(), asyncio.Event()

            async def checker(proxy, **kwargs):
                self.assertEqual("https", kwargs["mode"])
                self.assertEqual(3000, kwargs["timeout_ms"])
                started.set()
                await release.wait()
                return {"status": "alive" if proxy["host"] == "8.8.8.8" else "dead", "latencyMs": 1}

            async def fetcher(session, url, **kwargs):
                return "8.8.8.8:8080"

            engine = ProxyEngine(temporary, sources=[SOURCE], fetcher=fetcher, checker=checker,
                                 geo=FakeGeo(), auto_enabled=False)
            await engine.init()
            engine.live_only = True
            client = TestClient(TestServer(create_app(engine, token="test")))
            await client.start_server()
            headers = {"X-Proxy-Forge-Token": "test"}
            try:
                response = await client.post("/api/import", headers=headers,
                                             json={"text": "8.8.8.8:8080\n1.1.1.1:8080"})
                self.assertEqual(200, response.status)
                await asyncio.wait_for(started.wait(), 1)
                exported = await (await client.get("/api/export?format=json&status=all")).json()
                self.assertEqual([], exported)
                release.set()
                await engine.task
                exported = await (await client.get("/api/export?format=json&status=all")).json()
                self.assertEqual(["alive"], [p["status"] for p in exported])
                response = await client.post("/api/auto", headers=headers, json={"enabled": True})
                self.assertEqual(200, response.status)
                state = await response.json()
                self.assertEqual(60000, state["automation"]["intervalMs"])
                self.assertEqual({"limit": 100000, "concurrency": 10000, "timeoutMs": 3000}, state["automation"]["options"])
                response = await client.post("/api/stop", headers=headers, json={})
                self.assertFalse((await response.json())["automation"]["enabled"])
            finally:
                release.set()
                await client.close()
