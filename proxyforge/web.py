"""Loopback-only Python web server shared by the browser and Windows launcher."""

import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlencode
from secrets import token_urlsafe

from aiohttp import web

from .checker import CHECK_URL
from .engine import ProxyEngine

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
STATIC = {"/": (PUBLIC / "index.html", "text/html; charset=utf-8"),
          "/styles.css": (PUBLIC / "styles.css", "text/css; charset=utf-8"),
           "/app.js": (PUBLIC / "app.js", "text/javascript; charset=utf-8"),
           "/countries.json": (PUBLIC / "countries.json", "application/json; charset=utf-8"),
          "/favicon.svg": (PUBLIC / "favicon.svg", "image/svg+xml")}
ALLOWED_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$", re.I)
MAX_BODY = 8 * 1024 * 1024
ENGINE_KEY = web.AppKey("engine", ProxyEngine)
TOKEN_KEY = web.AppKey("token", str)


@web.middleware
async def security(request, handler):
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    return response


def check_origin(request):
    if not ALLOWED_HOST.fullmatch(request.headers.get("Host", "")):
        raise web.HTTPForbidden(text=json.dumps({"error": "Host không được phép."}), content_type="application/json")
    origin = request.headers.get("Origin")
    if origin and origin != "http://" + request.headers["Host"]:
        raise web.HTTPForbidden(text=json.dumps({"error": "Origin không được phép."}), content_type="application/json")
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden(text=json.dumps({"error": "Yêu cầu khác nguồn bị từ chối."}), content_type="application/json")


async def read_json(request):
    if not request.content_type.startswith("application/json"):
        raise web.HTTPUnsupportedMediaType(text=json.dumps({"error": "Yêu cầu JSON."}), content_type="application/json")
    if request.content_length and request.content_length > MAX_BODY:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=request.content_length)
    try:
        raw = await request.content.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=len(raw))
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text=json.dumps({"error": "JSON không hợp lệ."}), content_type="application/json") from None


def json_response(value, status=200):
    return web.json_response(value, status=status, headers={"Cache-Control": "no-store"})


def csv_cell(value):
    text = str(value if value is not None else "")
    if text.startswith(("=", "+", "-", "@")):
        text = "'" + text
    return '"{}"'.format(text.replace('"', '""'))


def create_app(engine=None, token=None):
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app[ENGINE_KEY] = engine or ProxyEngine()
    app[TOKEN_KEY] = token or token_urlsafe(32)

    async def startup(_app):
        await _app[ENGINE_KEY].init()
    app.on_startup.append(startup)
    app.on_cleanup.append(lambda _app: _app[ENGINE_KEY].close())

    async def static(request):
        path, content_type = STATIC[request.path]
        try:
            content = await asyncio.to_thread(path.read_bytes)
        except FileNotFoundError:
            raise web.HTTPNotFound(text="Static file is missing.")
        return web.Response(body=content, content_type=content_type.split(";", 1)[0],
                            charset="utf-8" if "charset=utf-8" in content_type else None,
                            headers={"Cache-Control": "no-cache"})

    async def state(request):
        result = request.app[ENGINE_KEY].snapshot()
        result.update(token=request.app[TOKEN_KEY], checkURL=CHECK_URL)
        return json_response(result)

    async def sources(request):
        return json_response(request.app[ENGINE_KEY].sources)

    async def proxies(request):
        query = request.query
        return json_response(request.app[ENGINE_KEY].list_proxies(
            search=query.get("search", ""), status=query.get("status", "all"),
            protocol=query.get("protocol", "all"), sort=query.get("sort", "latency"),
            country=query.get("country", "all"),
            page=query.get("page", 1), page_size=query.get("pageSize", 50)))

    async def export(request):
        engine = request.app[ENGINE_KEY]
        params = request.query
        fmt = params.get("format", "txt")
        if fmt not in ("txt", "json", "csv"):
            fmt = "txt"
        status = params.get("status", "alive")
        protocol = params.get("protocol", "all")
        country = params.get("country", "all").upper()
        bare = params.get("bare") == "1"
        rows = [proxy for proxy in engine.output_proxies()
                if (status == "all" or proxy.get("status") == status)
                and (protocol == "all" or proxy["protocol"] == protocol)
                and (country == "ALL" or (proxy.get("countryCode") or "UNKNOWN").upper() == country)]
        content_type = {"txt": "text/plain", "csv": "text/csv", "json": "application/json"}[fmt]
        response = web.StreamResponse(status=200, headers={
            "Content-Type": content_type + "; charset=utf-8",
            "Content-Disposition": 'attachment; filename="proxy-forge-{}-{}.{}"'.format(status, int(asyncio.get_running_loop().time()), fmt),
            "Cache-Control": "no-store"})
        await response.prepare(request)
        if fmt == "json":
            await response.write(b"[\n")
        elif fmt == "csv":
            await response.write(b"protocol,host,port,status,latency_ms,exit_ip,checked_at,error,country_code,country,city,server,asn\r\n")
        for start in range(0, len(rows), 500):
            batch = rows[start:start + 500]
            if fmt == "json":
                data = (",\n" if start else "") + ",\n".join(json.dumps(item, ensure_ascii=False) for item in batch)
            elif fmt == "csv":
                data = "".join(",".join(csv_cell(item.get(field)) for field in
                                ("protocol", "host", "port", "status", "latencyMs", "exitIP", "checkedAt", "error",
                                 "countryCode", "country", "city", "server", "asn")) + "\r\n"
                             for item in batch)
            else:
                data = "".join((item["id"].partition("://")[2] if bare else item["id"]) + "\n" for item in batch)
            await response.write(data.encode("utf-8"))
        if fmt == "json":
            await response.write(b"\n]\n")
        await response.write_eof()
        return response

    async def events(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                                                "Cache-Control": "no-cache",
                                                "X-Accel-Buffering": "no"})
        await response.prepare(request)
        engine = request.app[ENGINE_KEY]
        revision = -1
        try:
            while True:
                if engine._counter != revision:
                    revision = engine._counter
                    await response.write(("data: " + json.dumps(engine.snapshot(), ensure_ascii=False) + "\n\n").encode())
                    engine._source_changed.clear()
                    # Bound full-state broadcasts while 10,000 checks complete concurrently.
                    await asyncio.sleep(0.5)
                try:
                    await asyncio.wait_for(engine._source_changed.wait(), timeout=1.2)
                except TimeoutError:
                    await response.write(b": keep-alive\n\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return response

    @web.middleware
    async def api_guard(request, handler):
        if request.path.startswith("/api/"):
            check_origin(request)
        if request.method == "POST" and request.path.startswith("/api/"):
            if request.headers.get("X-Proxy-Forge-Token") != request.app[TOKEN_KEY]:
                return json_response({"error": "Phiên không hợp lệ. Hãy tải lại trang."}, 403)
        try:
            return await handler(request)
        except (ValueError, KeyError, TypeError) as error:
            return json_response({"error": str(error)[:200]}, 409 if request.app[ENGINE_KEY].busy else 400)

    app.middlewares.insert(0, api_guard)

    # Parse each request body once and reject malformed or oversized input.
    async def collect_handler(request):
        data = await read_json(request)
        return json_response(request.app[ENGINE_KEY].collect(
            limit=data.get("limit", 100000), concurrency=data.get("concurrency", 8),
            timeout_ms=data.get("timeoutMs", 12000)), 202)

    async def check_handler(request):
        data = await read_json(request)
        return json_response(request.app[ENGINE_KEY].check(
            mode=data.get("mode", "https"), concurrency=data.get("concurrency", 10000),
            timeout_ms=data.get("timeoutMs", 3000), protocols=data.get("protocols"),
            scope=data.get("scope", "all"), use_cache=False), 202)

    async def stop_handler(request):
        data = await read_json(request)
        await request.app[ENGINE_KEY].stop(disable_auto=data.get("preserveAuto") is not True)
        return json_response(request.app[ENGINE_KEY].snapshot())

    async def auto_handler(request):
        data = await read_json(request)
        return json_response(await request.app[ENGINE_KEY].configure_auto(
            enabled=data.get("enabled", True), limit=data.get("limit", 100000), concurrency=data.get("concurrency", 10000)))

    async def refresh_handler(request):
        data = await read_json(request)
        return json_response(request.app[ENGINE_KEY].refresh(
            limit=data.get("limit", 100000), concurrency=data.get("concurrency", 10000)), 202)

    async def import_handler(request):
        data = await read_json(request)
        if not isinstance(data.get("text"), str):
            raise ValueError("Danh sách proxy phải là văn bản.")
        return json_response(await request.app[ENGINE_KEY].import_proxies(data["text"], data.get("protocol", "http")))

    async def clear_handler(request):
        await read_json(request)
        await request.app[ENGINE_KEY].clear()
        return json_response(request.app[ENGINE_KEY].snapshot())

    async def toggle_sources(request):
        data = await read_json(request)
        await request.app[ENGINE_KEY].update_sources(data.get("ids"), data.get("enabled"))
        return json_response(request.app[ENGINE_KEY].snapshot())

    async def add_source(request):
        data = await read_json(request)
        await request.app[ENGINE_KEY].add_source(url=data.get("url"), name=data.get("name", ""),
                                                protocol=data.get("protocol", "http"))
        return json_response(request.app[ENGINE_KEY].snapshot(), 201)

    for path, (_filename, _ctype) in STATIC.items():
        app.router.add_get(path, static)
    app.router.add_get("/api/state", state)
    app.router.add_get("/api/sources", sources)
    app.router.add_get("/api/proxies", proxies)
    app.router.add_get("/api/export", export)
    app.router.add_get("/api/events", events)
    app.router.add_post("/api/collect", collect_handler)
    app.router.add_post("/api/check", check_handler)
    app.router.add_post("/api/stop", stop_handler)
    app.router.add_post("/api/auto", auto_handler)
    app.router.add_post("/api/refresh", refresh_handler)
    app.router.add_post("/api/import", import_handler)
    app.router.add_post("/api/clear", clear_handler)
    app.router.add_post("/api/sources/toggle", toggle_sources)
    app.router.add_post("/api/sources/add", add_source)
    return app


def main():
    port = int(os.environ.get("PORT", "8787"))
    if not 1 <= port <= 65535:
        raise SystemExit("PORT phải trong khoảng 1–65535.")
    print("Proxy Forge · Python: http://127.0.0.1:{}".format(port), flush=True)
    web.run_app(create_app(), host="127.0.0.1", port=port, print=None, shutdown_timeout=4)


if __name__ == "__main__":
    main()
