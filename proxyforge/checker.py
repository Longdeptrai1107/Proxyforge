"""Asynchronous protocol + verified HTTPS probes, with one total timeout."""

import asyncio
import ipaddress
import json
import os
import ssl
import struct
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .parsing import PROTOCOLS, public_ip

CHECK_URL = os.environ.get("CHECK_URL", "https://api.iplocate.io/ip")
TLS_CONTEXT = ssl.create_default_context()
MAX_BODY = 65536


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def read_headers(reader):
    data = await reader.readuntil(b"\r\n\r\n")
    if len(data) > 16384:
        raise ValueError("Header vượt 16 KB.")
    lines = data.decode("iso-8859-1").split("\r\n")
    parts = lines[0].split(" ", 2)
    if len(parts) < 2 or parts[0] not in ("HTTP/1.0", "HTTP/1.1") or not parts[1].isdigit():
        raise ValueError("Phản hồi HTTP không hợp lệ.")
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError("Header HTTP không hợp lệ.")
        key = key.lower()
        if key in headers and key in ("content-length", "transfer-encoding"):
            raise ValueError("Header phân khung bị lặp.")
        headers[key] = value.strip()
    return int(parts[1]), headers


async def read_body(reader, headers):
    if headers.get("content-encoding", "identity").lower() != "identity":
        raise ValueError("Đích kiểm tra phải trả nội dung không nén.")
    transfer = headers.get("transfer-encoding", "").lower()
    if transfer and transfer != "chunked":
        raise ValueError("Transfer-Encoding không được hỗ trợ.")
    if transfer == "chunked":
        chunks, total = [], 0
        while True:
            line = await reader.readuntil(b"\r\n")
            if len(line) > 128:
                raise ValueError("Chunk header quá dài.")
            size = int(line.strip().split(b";", 1)[0], 16)
            if size < 0 or total + size > MAX_BODY:
                raise ValueError("Phản hồi kiểm tra vượt 64 KB.")
            if size == 0:
                trailer_bytes = 0
                while True:
                    trailer = await reader.readuntil(b"\r\n")
                    trailer_bytes += len(trailer)
                    if trailer_bytes > 4096:
                        raise ValueError("Trailer quá dài.")
                    if trailer == b"\r\n":
                        return b"".join(chunks)
            chunks.append(await reader.readexactly(size))
            total += size
            if await reader.readexactly(2) != b"\r\n":
                raise ValueError("Chunk kết thúc không hợp lệ.")
    if "content-length" in headers:
        length = int(headers["content-length"])
        if not 0 <= length <= MAX_BODY:
            raise ValueError("Phản hồi kiểm tra vượt 64 KB.")
        return await reader.readexactly(length)
    chunks, total = [], 0
    while True:
        chunk = await reader.read(min(8192, MAX_BODY - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_BODY:
            raise ValueError("Phản hồi kiểm tra vượt 64 KB.")
        chunks.append(chunk)


async def handshake(reader, writer, protocol, host, port):
    domain = host.encode("idna")
    if protocol in ("http", "https"):
        authority = "{}:{}".format(host, port)
        writer.write(("CONNECT {0} HTTP/1.1\r\nHost: {0}\r\nUser-Agent: ProxyForge/1.0\r\n\r\n".format(authority)).encode("ascii"))
        await writer.drain()
        status, _ = await read_headers(reader)
        if status != 200:
            raise ValueError("CONNECT bị từ chối: HTTP {}".format(status))
    elif protocol == "socks5":
        writer.write(b"\x05\x01\x00")
        await writer.drain()
        if await reader.readexactly(2) != b"\x05\x00":
            raise ValueError("SOCKS5 yêu cầu xác thực hoặc sai giao thức.")
        if len(domain) > 255:
            raise ValueError("Tên miền đích quá dài.")
        writer.write(b"\x05\x01\x00\x03" + bytes([len(domain)]) + domain + struct.pack("!H", port))
        await writer.drain()
        reply = await reader.readexactly(4)
        if reply[:3] != b"\x05\x00\x00":
            raise ValueError("SOCKS5 từ chối kết nối ({}).".format(reply[1]))
        if reply[3] == 1:
            await reader.readexactly(6)
        elif reply[3] == 4:
            await reader.readexactly(18)
        elif reply[3] == 3:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length + 2)
        else:
            raise ValueError("SOCKS5 trả địa chỉ không hợp lệ.")
    elif protocol == "socks4":
        writer.write(b"\x04\x01" + struct.pack("!H", port) + b"\x00\x00\x00\x01\x00" + domain + b"\x00")
        await writer.drain()
        reply = await reader.readexactly(8)
        if reply[0] not in (0, 4) or reply[1] != 90:
            raise ValueError("SOCKS4a từ chối kết nối ({}).".format(reply[1]))
    else:
        raise ValueError("Giao thức không hợp lệ.")


async def check_proxy(proxy, *, mode="https", timeout_ms=3000, target_url=CHECK_URL,
                      allow_private=False, tls_context=None):
    started = time.perf_counter()
    writer = None
    elapsed = lambda: round((time.perf_counter() - started) * 1000)
    try:
        if proxy["protocol"] not in PROTOCOLS or not 1 <= int(proxy["port"]) <= 65535:
            raise ValueError("Proxy không hợp lệ.")
        ipaddress.ip_address(proxy["host"])
        if not allow_private and not public_ip(proxy["host"]):
            raise ValueError("Địa chỉ proxy không công khai.")
        target = urlsplit(target_url)
        if target.scheme != "https" or not target.hostname or target.username or target.password:
            raise ValueError("Đích kiểm tra phải là HTTPS không chứa tài khoản.")
        context = tls_context or TLS_CONTEXT
        async with asyncio.timeout(timeout_ms / 1000):
            secure_proxy = proxy["protocol"] == "https"
            reader, writer = await asyncio.open_connection(
                proxy["host"], proxy["port"], limit=16384,
                ssl=context if secure_proxy else None,
                server_hostname=proxy["host"] if secure_proxy else None,
            )
            connect_ms = elapsed()
            await handshake(reader, writer, proxy["protocol"], target.hostname, target.port or 443)
            handshake_ms = elapsed()
            result = {"connectMs": connect_ms, "handshakeMs": handshake_ms}
            if mode == "https":
                await writer.start_tls(context, server_hostname=target.hostname)
                path = target.path or "/"
                if target.query:
                    path += "?" + target.query
                writer.write(("GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: ProxyForge/1.0\r\n"
                              "Accept: text/plain, application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
                              .format(path, target.netloc)).encode("ascii"))
                await writer.drain()
                status, headers = await read_headers(reader)
                if status != 200:
                    raise ValueError("Đích kiểm tra trả HTTP {}.".format(status))
                body = (await read_body(reader, headers)).decode("utf-8").strip()
                try:
                    exit_ip = str(ipaddress.ip_address(body))
                except ValueError:
                    data = json.loads(body)
                    candidate = data.get("ip") or data.get("origin", "").split(",")[0].strip()
                    exit_ip = str(ipaddress.ip_address(candidate))
                result["exitIP"] = exit_ip
            result.update(status="alive" if mode == "https" else "handshake", latencyMs=elapsed(),
                          checkedAt=timestamp(), error=None)
            return result
    except asyncio.CancelledError:
        raise
    except Exception as error:
        message = ("Quá thời gian {} ms.".format(timeout_ms) if isinstance(error, TimeoutError)
                   else str(error) or type(error).__name__)
        return {"status": "dead", "latencyMs": elapsed(), "checkedAt": timestamp(), "error": message[:180]}
    finally:
        if writer is not None:
            # Abort also closes stalled TLS shutdowns; no background socket leak.
            writer.transport.abort()
