"""Persistent, bounded, asynchronous proxy collection and verification."""

import asyncio
import json
import math
import os
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .checker import CHECK_URL, check_proxy
from .feeds import feed_session, fetch_feed, validate_feed_url
from .geo import GeoLookup
from .parsing import MAX_PROXIES, PROTOCOLS, parse_proxies, proxy_key

MAX_CONCURRENCY = 10_000
AUTO_INTERVAL_MS = 60_000
DATA_DIR = Path(os.environ.get("PROXYFORGE_DATA", Path(__file__).resolve().parent.parent / "data"))
SOURCES_FILE = Path(__file__).with_name("sources.json")


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def clamp(value, lower, upper, fallback):
    try:
        return max(lower, min(upper, int(value)))
    except (TypeError, ValueError, OverflowError):
        return fallback


class ProxyEngine:
    def __init__(self, data_directory=None, *, sources=None, fetcher=None, checker=None, geo=None,
                 auto_enabled=True, auto_interval_ms=AUTO_INTERVAL_MS):
        self.data_directory = Path(data_directory or DATA_DIR)
        self.state_path = self.data_directory / "state.json"
        if sources is None:
            with SOURCES_FILE.open(encoding="utf-8") as source_file:
                sources = json.load(source_file)
        self.sources = [dict(source) for source in sources]
        self.fetcher = fetcher or fetch_feed
        self.checker = checker or check_proxy
        self.geo = geo if geo is not None else GeoLookup(self.data_directory)
        self.proxies = OrderedDict()
        self.cache = OrderedDict()
        self.job = None
        self.task = None
        self._cancel = None
        self._counter = 0
        self._state_lock = asyncio.Lock()
        self._save_task = None
        self._warning = None
        self._source_changed = asyncio.Event()
        self.automation = {"enabled": auto_enabled is not False, "intervalMs": auto_interval_ms,
                           "nextRunAtMs": None, "lastRunAtMs": None, "rounds": 0, "error": None,
                           "options": {"limit": MAX_PROXIES, "concurrency": 10_000, "timeoutMs": 3000}}
        self.live_only = True
        self._auto_task = None
        self._initialized = False

    async def init(self):
        if self._initialized:
            return self
        self.data_directory.mkdir(parents=True, exist_ok=True)
        try:
            saved = json.loads(await asyncio.to_thread(self.state_path.read_text, encoding="utf-8"))
            automation = saved.get("automation", {})
            # A saved pause belongs to that process. Every backend startup runs
            # automatically; explicit overrides are only for embedded/test uses.
            self.automation["options"] = self._auto_options(automation.get("options", {}))
            old_sources = {s["id"]: s for s in saved.get("sources", [])}
            known = {s["id"] for s in self.sources}
            for source in self.sources:
                old = old_sources.get(source["id"])
                if old:
                    source.update(enabled=old.get("enabled") is not False, status=old.get("status")
                                  if old.get("status") != "fetching" else "idle",
                                  count=old.get("count", 0), error=old.get("error"),
                                  fetchedAt=old.get("fetchedAt"), durationMs=old.get("durationMs"))
            for old in saved.get("sources", []):
                if old.get("custom") and old["id"] not in known:
                    try:
                        old["url"] = validate_feed_url(old["url"])
                        self.sources.append(old)
                    except ValueError:
                        pass
            for proxy in saved.get("proxies", [])[:MAX_PROXIES]:
                parsed = parse_proxies(proxy_key(proxy), proxy["protocol"], limit=1)
                if parsed:
                    item = {**proxy, **parsed[0], "id": proxy_key(parsed[0])}
                    if item.get("status") == "checking":
                        item["status"] = "pending"
                    self.proxies[item["id"]] = item
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            self._warning = "Không đọc được phiên cũ: {}".format(str(error)[:100])
        self._initialized = True
        if self.automation["enabled"]:
            self._start_automation()
        return self

    @staticmethod
    def _auto_options(options):
        return {"limit": clamp(options.get("limit"), 1, MAX_PROXIES, MAX_PROXIES),
                "concurrency": clamp(options.get("concurrency"), 1, MAX_CONCURRENCY, 10_000),
                "timeoutMs": 3000}

    def _start_automation(self):
        if self._auto_task is None or self._auto_task.done():
            self.automation["nextRunAtMs"] = round(time.time() * 1000)
            self._auto_task = asyncio.create_task(self._auto_loop(), name="proxy-auto")
        self._touch()

    async def configure_auto(self, *, enabled=True, limit=MAX_PROXIES, concurrency=10_000):
        if not isinstance(enabled, bool):
            raise ValueError("Trạng thái tự động không hợp lệ.")
        if not enabled:
            await self.stop()
            return self.snapshot()
        if not any(source.get("enabled") for source in self.sources):
            raise ValueError("Hãy bật ít nhất một nguồn.")
        self.automation.update(enabled=True, error=None)
        self.automation["options"] = self._auto_options({"limit": limit, "concurrency": concurrency})
        self.live_only = True
        self._start_automation()
        await self.save()
        return self.snapshot()

    async def _auto_loop(self):
        try:
            while self.automation["enabled"]:
                delay = max(0, (self.automation["nextRunAtMs"] - time.time() * 1000) / 1000)
                await asyncio.sleep(delay)
                if self.busy:
                    await asyncio.shield(self.task)
                if not self.automation["enabled"]:
                    break
                started = round(time.time() * 1000)
                self.automation.update(lastRunAtMs=started, nextRunAtMs=None, error=None)
                try:
                    self.refresh(**{"limit": self.automation["options"]["limit"],
                                    "concurrency": self.automation["options"]["concurrency"]})
                    await asyncio.shield(self.task)
                    self.automation["rounds"] += 1
                    self.automation["error"] = self.job.get("error")
                except Exception as error:
                    self.automation["error"] = str(error)[:180]
                self.automation["nextRunAtMs"] = max(started + self.automation["intervalMs"], round(time.time() * 1000))
                self._touch()
                await self.save()
        except asyncio.CancelledError:
            pass

    def output_proxies(self):
        return [proxy for proxy in self.proxies.values() if proxy.get("status") == "alive"]

    @property
    def busy(self):
        return bool(self.job and self.job.get("state") == "running")

    def _idle(self):
        if self.busy:
            raise ValueError("Một tác vụ đang chạy. Hãy dừng trước khi đổi dữ liệu.")

    async def save(self):
        self.data_directory.mkdir(parents=True, exist_ok=True)
        async with self._state_lock:
            snapshot = json.dumps({"version": 1, "sources": self.sources, "liveOnly": self.live_only,
                                   "automation": self.automation, "proxies": self.output_proxies()}, ensure_ascii=False,
                                  separators=(",", ":"))

            def atomic_write():
                tmp = self.state_path.with_suffix(".tmp")
                tmp.write_text(snapshot, encoding="utf-8")
                os.replace(tmp, self.state_path)
            writing = asyncio.create_task(asyncio.to_thread(atomic_write))
            try:
                await asyncio.shield(writing)
            except asyncio.CancelledError:
                # Stop can cancel the scheduler during a save. Keep the lock until
                # its write finishes so the final disabled state wins on disk.
                await asyncio.shield(writing)
                raise
            except OSError as error:
                self._warning = "Không lưu được phiên: {}".format(str(error)[:100])

    def _touch(self):
        self._counter += 1
        self._source_changed.set()

    def snapshot(self):
        output = self.output_proxies()
        counts = {"total": len(output), "pending": 0, "checking": 0,
                  "alive": 0, "handshake": 0, "dead": 0}
        measured = []
        protocol_counts = {protocol: 0 for protocol in PROTOCOLS}
        country_counts = {}
        for proxy in output:
            protocol_counts[proxy["protocol"]] += 1
            country = proxy.get("countryCode") or "unknown"
            country_counts[country] = country_counts.get(country, 0) + 1
            status = proxy.get("status")
            if status in counts:
                counts[status] += 1
            if status == "alive" and isinstance(proxy.get("latencyMs"), (int, float)):
                measured.append(proxy["latencyMs"])
        source_statuses = [source.get("status") for source in self.sources]
        elapsed_ms = max(1, (self.job.get("finishedAtMs") or int(time.time() * 1000)) - self.job["startedAtMs"]) if self.job else 0
        job = {**self.job, "elapsedMs": elapsed_ms,
               "rate": round(self.job.get("networkChecked", 0) / (elapsed_ms / 1000)) if self.job and self.job.get("networkChecked") else 0} if self.job else None
        if job:
            job["etaSeconds"] = (math.ceil((job["total"] - job["completed"]) / job["rate"])
                                  if job["state"] == "running" and job["phase"] in ("check", "recheck") and job["rate"] else None)
        return {
            "revision": self._counter, "counts": counts, "job": job,
            "automation": {**self.automation}, "liveOnly": self.live_only,
            "protocolCounts": protocol_counts, "countryCounts": country_counts,
            "latencyMs": round(sum(measured) / len(measured)) if measured else None,
            "sources": {"total": len(self.sources), "enabled": sum(bool(s.get("enabled")) for s in self.sources),
                        "publishers": len({s.get("publisher") for s in self.sources}),
                        "domains": len({urlsplit(s["url"]).hostname for s in self.sources}),
                        "ok": source_statuses.count("ok"), "failed": source_statuses.count("error")},
            "limits": {"maxProxies": MAX_PROXIES, "maxConcurrency": MAX_CONCURRENCY},
            "warning": self._warning,
        }

    def list_proxies(self, *, search="", status="all", protocol="all", country="all", sort="latency", page=1, page_size=50):
        rows = self.output_proxies()
        query = str(search).casefold()[:100]
        if query:
            rows = [p for p in rows if any(query in str(p.get(field) or "").casefold()
                    for field in ("id", "exitIP", "server", "asn", "countryCode", "country", "city"))]
        if status != "all":
            rows = [p for p in rows if p.get("status") == status]
        if protocol != "all":
            rows = [p for p in rows if p["protocol"] == protocol]
        if country != "all":
            country = str(country).upper()
            rows = [p for p in rows if (p.get("countryCode") or "UNKNOWN").upper() == country]
        if sort == "latency":
            rows.sort(key=lambda p: (0 if p.get("status") == "alive" else 1 if p.get("status") == "handshake" else 2,
                                     p.get("latencyMs") if p.get("latencyMs") is not None else math.inf))
        page_size = clamp(page_size, 1, 200, 50)
        pages = max(1, math.ceil(len(rows) / page_size))
        page = clamp(page, 1, pages, 1)
        return {"rows": rows[(page - 1) * page_size:page * page_size], "total": len(rows),
                "pages": pages, "page": page, "pageSize": page_size}

    def _start_job(self, kind, total, options):
        self._idle()
        self._cancel = asyncio.Event()
        self.job = {"id": str(uuid.uuid4()), "type": kind, "state": "running", "total": total,
                    "completed": 0, "startedAtMs": round(time.time() * 1000),
                    "networkChecked": 0, "cached": 0, "errors": 0, "added": 0,
                     "duplicates": 0, "active": 0, "options": options}
        self.job.update(removed=0, liveAdded=0, phase=kind)
        self._touch()

    async def _run_job(self, worker):
        error = None
        try:
            await worker()
        except asyncio.CancelledError:
            if self._cancel:
                self._cancel.set()
            raise
        except Exception as caught:
            error = caught
        finally:
            if self.job:
                self.job.update(state="error" if error else "stopped" if self._cancel and self._cancel.is_set() else "done",
                                finishedAtMs=round(time.time() * 1000), active=0)
                if error:
                    self.job["error"] = str(error)[:180]
                self._touch()
                await self.save()

    def collect(self, *, limit=MAX_PROXIES, concurrency=8, timeout_ms=12_000):
        # Keep the old endpoint as an alias for a complete, fresh live refresh.
        return self.refresh(limit=limit, concurrency=self.automation["options"]["concurrency"])

    async def _fetch_sources(self, selected, *, limit, concurrency=8, timeout_ms=12000, inventory=None, fresh=False):
        queue = asyncio.Queue()
        for source in selected:
            queue.put_nowait(source)
        async with feed_session() as session:
            async def worker():
                while not self._cancel.is_set():
                    try:
                        source = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    started = time.perf_counter()
                    source.update(status="fetching", error=None)
                    self.job["active"] += 1
                    self._touch()
                    try:
                        entries, feed_errors = {}, []
                        for feed in source.get("feeds") or [source]:
                            if self._cancel.is_set():
                                return
                            try:
                                cached = self.cache.get(feed["url"])
                                if not fresh and cached and time.time() - cached["time"] < 300:
                                    text = cached["text"]
                                else:
                                    text = await self.fetcher(session, feed["url"], timeout_ms=timeout_ms)
                                    self.cache[feed["url"]] = {"time": time.time(), "text": text}
                                    self.cache.move_to_end(feed["url"])
                                    while len(self.cache) > 16:
                                        self.cache.popitem(last=False)
                                for proxy in parse_proxies(text, feed["protocol"]):
                                    entries[proxy_key(proxy)] = proxy
                            except Exception as feed_error:
                                feed_errors.append((str(feed_error) or type(feed_error).__name__)[:160])
                        source["feedErrors"] = feed_errors
                        if not entries:
                            raise ValueError(feed_errors[0] if feed_errors else "Không có proxy hợp lệ trong phản hồi.")
                        added, duplicates = self.add_proxies(entries.values(), source["id"], max_proxies=limit, inventory=inventory)
                        self.job["added"] += added
                        self.job["duplicates"] += duplicates
                        source.update(status="ok", count=len(entries), fetchedAt=stamp())
                    except asyncio.CancelledError:
                        source.update(status="idle", error=None)
                        raise
                    except Exception as error:
                        source.update(status="error", error=str(error)[:180])
                        self.job["errors"] += 1
                    finally:
                        source["durationMs"] = round((time.perf_counter() - started) * 1000)
                        self.job["completed"] += 1
                        self.job["active"] -= 1
                        self._touch()
            workers = [asyncio.create_task(worker()) for _ in range(min(concurrency, len(selected)))]
            try:
                await asyncio.gather(*workers)
            finally:
                for task in workers:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)

    def refresh(self, *, limit=MAX_PROXIES, concurrency=10_000):
        self._idle()
        selected = [source for source in self.sources if source.get("enabled")]
        if not selected:
            raise ValueError("Hãy bật ít nhất một nguồn.")
        limit = clamp(limit, 1, MAX_PROXIES, MAX_PROXIES)
        concurrency = clamp(concurrency, 1, MAX_CONCURRENCY, 10_000)
        candidates = OrderedDict((key, {**proxy, "sources": list(proxy.get("sources", []))}) for key, proxy in self.proxies.items())
        self.live_only = True
        self.proxies = OrderedDict((key, proxy) for key, proxy in self.proxies.items() if proxy.get("status") == "alive")
        self._start_job("refresh", len(selected), {"limit": limit, "concurrency": concurrency, "timeoutMs": 3000, "mode": "https"})
        self.job["phase"] = "collect"

        async def run():
            await self._fetch_sources(selected, limit=limit, inventory=candidates, fresh=True)
            if self._cancel.is_set():
                return
            self.job["total"] += len(candidates)
            self.job["phase"] = "check"
            self._touch()
            await self._measure(list(candidates.values()), mode="https", concurrency=concurrency, timeout_ms=3000)
        self.task = asyncio.create_task(self._run_job(run), name="proxy-refresh")
        return self.snapshot()

    def check(self, *, mode="https", concurrency=10_000, timeout_ms=3000, protocols=None,
              scope="all", use_cache=False):
        self._idle()
        mode = "https"
        concurrency = clamp(concurrency, 1, MAX_CONCURRENCY, 10_000)
        timeout_ms = 3000
        protocols = protocols if isinstance(protocols, list) else list(PROTOCOLS)
        protocols = [p for p in protocols if p in PROTOCOLS]
        candidates = [p for p in self.proxies.values() if p["protocol"] in protocols and
                      (scope != "pending" or p.get("status") == "pending")]
        if not candidates:
            raise ValueError("Chưa có proxy phù hợp. Hãy thu thập hoặc nhập danh sách.")
        candidates = [{**proxy, "sources": list(proxy.get("sources", []))} for proxy in candidates]
        self.proxies = OrderedDict((key, proxy) for key, proxy in self.proxies.items() if proxy.get("status") == "alive")
        self._start_job("check", len(candidates), {"mode": mode, "concurrency": concurrency, "timeoutMs": timeout_ms})
        self.task = asyncio.create_task(self._run_job(lambda: self._measure(
            candidates, mode=mode, concurrency=concurrency, timeout_ms=timeout_ms)), name="proxy-check")
        return self.snapshot()

    async def _measure(self, candidates, *, mode, concurrency, timeout_ms):
        cursor = 0

        async def worker():
            nonlocal cursor
            while not self._cancel.is_set() and cursor < len(candidates):
                proxy = candidates[cursor]
                cursor += 1
                previous = proxy.get("status", "pending")
                proxy["status"] = "checking"
                self.job["active"] += 1
                self._touch()
                try:
                    result = await self.checker(proxy, mode=mode, timeout_ms=timeout_ms)
                    proxy.update({"exitIP": None, **result, "checkMode": mode, "checkTimeoutMs": timeout_ms})
                    self.job["networkChecked"] += 1
                    self.job["completed"] += 1
                    if result["status"] == "alive":
                        if proxy["id"] not in self.proxies:
                            self.job["liveAdded"] += 1
                        self.proxies[proxy["id"]] = proxy
                    else:
                        if self.proxies.pop(proxy["id"], None) is not None:
                            self.job["removed"] += 1
                        self.job["errors"] += 1
                except asyncio.CancelledError:
                    proxy["status"] = previous
                    raise
                except Exception:
                    proxy["status"] = previous
                    raise
                finally:
                    self.job["active"] -= 1
                    self._touch()
                if cursor % 128 == 0:
                    await asyncio.sleep(0)

        workers = [asyncio.create_task(worker()) for _ in range(min(concurrency, len(candidates)))]
        try:
            await asyncio.gather(*workers)
        finally:
            for task in workers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        if self._cancel.is_set():
            return
        self._touch()
        live = [proxy for proxy in candidates if proxy.get("status") == "alive"]
        if live:
            self.job["phase"] = "location"
            self._touch()
            try:
                await self.geo.prepare()
                if self.geo.warning:
                    self.job["geoWarning"] = self.geo.warning
                for proxy in live:
                    metadata = self.geo.lookup(proxy["host"])
                    if metadata.get("countryCode") and (not proxy.get("countryCode") or
                            str(proxy.get("locationSource", "")).startswith("IPtoASN")):
                        proxy["countryCode"] = metadata["countryCode"]
                        proxy["locationSource"] = metadata.get("locationSource")
                    for field, value in metadata.items():
                        if not proxy.get(field):
                            proxy[field] = value
            except (OSError, ValueError, EOFError) as error:
                self.job["geoWarning"] = str(error)[:160]
            self._touch()

    def add_proxies(self, proxies, source=None, max_proxies=MAX_PROXIES, *, inventory=None):
        inventory = self.proxies if inventory is None else inventory
        added = duplicates = 0
        for proxy in proxies:
            key = proxy_key(proxy)
            existing = inventory.get(key)
            if existing:
                duplicates += 1
                for field in ("countryCode", "country", "city", "region", "server", "asn", "locationSource", "locationApproximate"):
                    if proxy.get(field) is not None:
                        existing[field] = proxy[field]
                if source and source not in existing.setdefault("sources", []):
                    existing["sources"].append(source)
            elif len(inventory) < max_proxies:
                inventory[key] = {**proxy, "id": key, "sources": [source] if source else [],
                                     "status": "pending", "latencyMs": None,
                                     "checkedAt": None, "exitIP": None, "error": None}
                added += 1
        return added, duplicates

    async def import_proxies(self, text, protocol="http"):
        self._idle()
        if not isinstance(text, str) or len(text.encode("utf-8")) > 8 * 1024 * 1024:
            raise ValueError("Danh sách proxy tối đa 8 MB.")
        if protocol not in PROTOCOLS:
            raise ValueError("Giao thức không hợp lệ.")
        parsed = parse_proxies(text, protocol)
        if not parsed:
            raise ValueError("Không tìm thấy IP công khai và cổng hợp lệ.")
        added, duplicates = self.add_proxies(parsed, "manual")
        self.check(concurrency=self.automation["options"]["concurrency"])
        self._touch()
        await self.save()
        return {"parsed": len(parsed), "added": added, "duplicates": duplicates, **self.snapshot()}

    async def update_sources(self, ids, enabled):
        self._idle()
        if not isinstance(ids, list) or not isinstance(enabled, bool):
            raise ValueError("Cấu hình nguồn không hợp lệ.")
        ids = set(map(str, ids))
        for source in self.sources:
            if source["id"] in ids:
                source["enabled"] = enabled
        self._touch()
        await self.save()

    async def add_source(self, *, url, name="", protocol="http"):
        self._idle()
        url = validate_feed_url(url)
        if protocol not in PROTOCOLS or len(self.sources) >= 500:
            raise ValueError("Giao thức không hợp lệ hoặc vượt quá 500 nguồn.")
        if any(source["url"] == url for source in self.sources):
            raise ValueError("Nguồn đã có trong danh sách.")
        from urllib.parse import urlsplit
        host = urlsplit(url).hostname
        self.sources.append({"id": "custom-{}".format(uuid.uuid4()),
                             "name": str(name or host)[:80], "publisher": host,
                             "protocol": protocol, "url": url,
                             "homepage": "https://{}".format(host), "enabled": True,
                             "custom": True, "status": "idle", "count": 0, "error": None})
        self._touch()
        await self.save()

    async def stop(self, *, disable_auto=True):
        if disable_auto:
            self.automation["enabled"] = False
        self.automation["nextRunAtMs"] = None
        if self._auto_task:
            self._auto_task.cancel()
            await asyncio.gather(self._auto_task, return_exceptions=True)
            self._auto_task = None
        if self._cancel and self.busy:
            self._cancel.set()
            if self.task:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            if self.busy:
                self.job.update(state="stopped", finishedAtMs=round(time.time() * 1000), active=0)
                await self.save()
        self._touch()
        await self.save()

    async def clear(self):
        self._idle()
        self.proxies.clear()
        self.job = None
        self._touch()
        await self.save()

    async def close(self):
        await self.stop(disable_auto=False)
        if self.task:
            await asyncio.gather(self.task, return_exceptions=True)
        await self.save()
