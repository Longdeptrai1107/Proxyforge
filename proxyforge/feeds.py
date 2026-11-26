"""Fetch bounded HTTPS feeds, pinning public DNS answers to each connection."""

import asyncio
import socket
from urllib.parse import urlsplit, urljoin

import aiohttp
from aiohttp.abc import AbstractResolver

from .parsing import public_ip

MAX_FEED_BYTES = 4 * 1024 * 1024


def validate_feed_url(value):
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if (parsed.scheme != "https" or parsed.username or parsed.password or
                parsed.port not in (None, 443) or not host or len(value) > 2048 or
                host == "localhost" or host.endswith((".localhost", ".local"))):
            raise ValueError()
        # Numeric hosts must be global. Domain names are resolved by PublicResolver.
        try:
            socket.inet_pton(socket.AF_INET6 if ":" in host else socket.AF_INET, host)
        except OSError:
            pass
        else:
            if not public_ip(host):
                raise ValueError()
        return parsed._replace(fragment="").geturl()
    except (ValueError, TypeError):
        raise ValueError("Nguồn cần HTTPS công khai, cổng 443, không chứa tài khoản.") from None


class PublicResolver(AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM)
        if not infos or any(not public_ip(info[4][0]) for info in infos):
            raise OSError("DNS của nguồn trỏ đến mạng nội bộ hoặc địa chỉ đặc biệt.")
        return [{"hostname": host, "host": info[4][0], "port": port,
                 "family": info[0], "proto": info[2], "flags": socket.AI_NUMERICHOST}
                for info in infos]

    async def close(self):
        pass


def feed_session():
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(resolver=PublicResolver(), limit=16, ttl_dns_cache=120),
        trust_env=False,
        headers={"User-Agent": "ProxyForge/1.0 (public-feed-reader)",
                 "Accept": "text/plain, application/json, text/html;q=0.8", "Accept-Encoding": "gzip, deflate"},
    )


async def fetch_feed(session, value, *, timeout_ms=12_000):
    async with asyncio.timeout(timeout_ms / 1000):
        url = validate_feed_url(value)
        for _ in range(4):
            async with session.get(url, allow_redirects=False, max_line_size=8192, max_field_size=8192) as response:
                if response.status in (301, 302, 303, 307, 308) and response.headers.get("Location"):
                    url = validate_feed_url(urljoin(url, response.headers["Location"]))
                    continue
                if response.status != 200:
                    raise ValueError("HTTP {}".format(response.status))
                if response.content_length and response.content_length > MAX_FEED_BYTES:
                    raise ValueError("Nguồn vượt giới hạn 4 MB.")
                chunks = []
                size = 0
                async for chunk in response.content.iter_chunked(32768):
                    size += len(chunk)
                    if size > MAX_FEED_BYTES:
                        raise ValueError("Nguồn giải nén vượt giới hạn 4 MB.")
                    chunks.append(chunk)
                return b"".join(chunks).decode("utf-8", errors="replace")
        raise ValueError("Nguồn chuyển hướng quá nhiều.")
