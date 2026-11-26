"""Parse public proxy addresses from JSON, text and common website HTML."""

import base64
import ipaddress
import json
import re
from html import unescape

PROTOCOLS = ("http", "https", "socks4", "socks5")
MAX_PROXIES = 100_000
ADDRESS = re.compile(
    r"(?:(https?|socks[45])://)?(?:([^\s<>\"'@]+)@)?"
    r"(\[(?:[0-9a-f]*:)+[0-9a-f:.]*\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?!\d)",
    re.IGNORECASE,
)


def public_ip(host):
    try:
        ip = ipaddress.ip_address(host)
        return (ip.is_global and not ip.is_multicast and
                not (isinstance(ip, ipaddress.IPv6Address) and
                     (ip.ipv4_mapped or ip.sixtofour or ip.teredo)))
    except ValueError:
        return False


def proxy_key(proxy):
    host = proxy["host"]
    return "{}://{}:{}".format(proxy["protocol"], "[{}]".format(host) if ":" in host else host, proxy["port"])


def parse_proxies(text, default_protocol="http", *, limit=MAX_PROXIES, allow_private=False):
    found = {}

    def decode_base64(match):
        value = match.group(2)
        try:
            decoded = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
            if len(decoded) <= 2048:
                return unescape(decoded.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            pass
        return match.group(0)

    # Several public proxy-list pages encode addresses in harmless inline
    # document.write/Proxy calls. Decode only recognized Base64 wrappers; do
    # not evaluate page JavaScript.
    text = re.sub(r"(?i)\bProxy\s*\(\s*(['\"])([A-Za-z0-9+/=_-]{8,128})\1\s*\)",
                  decode_base64, text)
    text = re.sub(r"(?i)document\.write\s*\(\s*atob\(\s*(['\"])([A-Za-z0-9+/=_-]{4,128})\1\s*\)\s*\)",
                  decode_base64, text)

    # ProxyNova-style rows sometimes build an address using a substring plus
    # one Base64-decoded octet. Support that restricted expression shape only.
    def decode_substring_parts(match):
        _quote, source, start, end, _encoded_quote, encoded = match.groups()
        try:
            def index(expression):
                pieces = re.fullmatch(r"\s*(\d+)\s*([+-])?\s*(\d+)?\s*", expression)
                if not pieces:
                    raise ValueError()
                first, operator, second = pieces.groups()
                return int(first) + (int(second) if operator == "+" else -int(second) if operator == "-" else 0)
            suffix = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
            if len(suffix) > 16:
                return match.group(0)
            return source[index(start):index(end)] + suffix.decode("ascii")
        except (ValueError, UnicodeDecodeError):
            return match.group(0)

    text = re.sub(
        r'''(?i)document\.write\s*\(\s*(["'])([^"']{1,100})\1\s*\.substring\(\s*([^,()]{1,16})\s*,\s*([^,()]{1,16})\s*\)\s*\.concat\(\s*atob\(\s*(["'])([A-Za-z0-9+/=_-]{4,32})\5\s*\)\s*\)\s*\)''',
        lambda m: decode_substring_parts(m), text)

    def decode_repeated(match):
        _quote, value, repeats, start, end = match.groups()
        repeats, start = int(repeats), int(start)
        if repeats > 16 or start > 256 or (end and int(end) > 256):
            return match.group(0)
        repeated = value * repeats
        return repeated[start:int(end) if end else None]

    text = re.sub(r'''(["'])([^"']{1,64})\1\.repeat\((\d{1,2})\)\.substring\((\d{1,3})(?:\s*,\s*(\d{1,3}))?\)''',
                  decode_repeated, text)

    def decode_atob_match(match):
        encoded, suffix = match.group(2), match.group(4)
        try:
            decoded = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True).decode("ascii")
            return decoded + suffix[::-1]
        except (ValueError, UnicodeDecodeError):
            return match.group(0)

    text = re.sub(
        r'''atob\(\s*(["'])([A-Za-z0-9+/=_-]{4,128})\1\s*\)\.concat\(\s*(["'])([^"']{1,64})\3\.split\(["']{2}\)\.reverse\(\)\.join\(["']{2}\)\s*\)''',
        decode_atob_match, text)

    def reverse_literal(match):
        return match.group(2)[::-1]

    text = re.sub(r'''(["'])([^"']{1,64})\1\.split\(["']{2}\)\.reverse\(\)\.join\(["']{2}\)''',
                  reverse_literal, text)

    text = re.sub(
        r'''(["'])([^"']{1,128})\1\.concat\(\s*(["'])([^"']{1,128})\3\s*\)''',
        lambda m: m.group(2) + m.group(4), text)

    def safe_index(expression):
        match = re.fullmatch(r"\s*(\d+)\s*([+-])?\s*(\d+)?\s*", expression)
        if not match:
            return None
        first, operator, second = match.groups()
        return int(first) + (int(second) if operator == "+" else -int(second) if operator == "-" else 0)

    def decode_substring(match):
        _quote, value, start, end = match.groups()
        first = safe_index(start)
        last = safe_index(end) if end else None
        if first is None or first > 512 or last is not None and last > 512:
            return match.group(0)
        return value[first:last]

    def decode_char_codes(match):
        values = [int(value) for value in re.findall(r"\d+", match.group(1))]
        operator, adjustment = match.group(2), int(match.group(3))
        if len(values) > 128:
            return match.group(0)
        codes = [value + adjustment if operator == "+" else value - adjustment for value in values]
        if any(not 0 <= code <= 127 for code in codes):
            return match.group(0)
        return "".join(chr(code) for code in codes)

    text = re.sub(r'''atob\(\s*(["'])([A-Za-z0-9+/=_-]{4,128})\1\s*\)''',
                  lambda m: json.dumps(decode_base64(m)) if decode_base64(m) != m.group(0) else m.group(0), text)
    text = re.sub(
        r'''\[([\d,\s]{1,512})\]\.map\(\(\s*\w+\s*\)\s*=>\s*String\.fromCharCode\(\s*\w+\s*([+-])\s*(\d+)\s*\)\s*\)\.join\(["']{2}\)''',
        decode_char_codes, text)

    for _ in range(8):
        previous = text
        text = re.sub(r'''(["'])([^"']{1,128})\1\.substring\(\s*([^,()]{1,16})(?:\s*,\s*([^,()]{1,16}))?\s*\)''',
                      decode_substring, text)
        text = re.sub(
            r'''(["'])([^"']{1,128})\1\.concat\(\s*(["'])([^"']{1,128})\3\s*\)''',
            lambda m: m.group(2) + m.group(4), text)
        if text == previous:
            break

    def add(host, port, protocol=default_protocol, metadata=None):
        try:
            host = str(ipaddress.ip_address(str(host).strip("[]")))
            port = int(port)
            protocol = str(protocol).lower()
        except (ValueError, TypeError):
            return
        if protocol not in PROTOCOLS or not 1 <= port <= 65535 or (not allow_private and not public_ip(host)):
            return
        proxy = {"host": host, "port": port, "protocol": protocol}
        if metadata:
            details = metadata.get("ip_data") or metadata.get("connection") or metadata
            if not isinstance(details, dict):
                details = metadata
            country = metadata.get("country_code") or metadata.get("countryCode") or metadata.get("cc") or details.get("countryCode") or metadata.get("country")
            if isinstance(country, str) and re.fullmatch(r"[a-zA-Z]{2}", country):
                proxy["countryCode"] = country.upper()
            for field, value in {
                "country": metadata.get("countryName") or metadata.get("country_name") or details.get("country"),
                "city": metadata.get("city") or details.get("city"),
                "region": metadata.get("region") or details.get("regionName"),
                "server": metadata.get("asn_org") or metadata.get("server") or metadata.get("isp") or details.get("isp") or details.get("org"),
            }.items():
                if isinstance(value, str) and value.strip():
                    proxy[field] = value.strip()[:160]
            asn = metadata.get("asn") or details.get("asn") or details.get("as")
            asn_match = re.match(r"(?:AS)?(\d+)\b", str(asn), re.I)
            if asn_match:
                proxy["asn"] = int(asn_match.group(1))
            if len(proxy) > 3:
                proxy["locationSource"] = "feed"
                proxy["locationApproximate"] = True
        if len(found) < limit:
            key = proxy_key(proxy)
            found[key] = {**found.get(key, {}), **proxy}

    is_json = False
    if text.lstrip().startswith(("{", "[")):
        try:
            stack = [json.loads(text)]
            is_json = True
            visited = 0
            while stack and len(found) < limit and visited < 400_000:
                visited += 1
                value = stack.pop()
                if isinstance(value, list):
                    stack.extend(reversed(value))
                elif isinstance(value, dict):
                    host = value.get("ip") or value.get("host") or value.get("ipAddress") or value.get("ip_address") or value.get("addr")
                    if host and value.get("port") and not (value.get("username") or value.get("password")):
                        protocols = value.get("protocols") or [value.get("protocol") or value.get("proxy_type") or value.get("scheme") or value.get("type") or default_protocol]
                        if isinstance(protocols, str):
                            protocols = [protocols]
                        for protocol in protocols:
                            add(host, value["port"], protocol, value)
                    stack.extend(child for child in value.values() if isinstance(child, (dict, list)))
                    if not (host and value.get("port")):
                        stack.extend(child for child in value.values() if isinstance(child, str))
                elif isinstance(value, str):
                    for match in ADDRESS.finditer(value):
                        protocol, credentials, host, port = match.groups()
                        if not credentials:
                            add(host, port, protocol or default_protocol)
        except (ValueError, RecursionError, TypeError):
            pass

    # Spys.one keeps the proxy IP visible but derives each port digit from
    # XORs in an inline script. Resolve only integer assignments and XORs.
    xor_values = {}
    assignments = re.findall(
        r"\b([a-z_]\w*)\s*=\s*(\d+)\s*(?:\^\s*([a-z_]\w*))?\s*;", text, re.I)
    for _ in range(len(assignments)):
        changed = False
        for name, number, other in assignments:
            if other and other.lower() not in xor_values:
                continue
            value = int(number) ^ xor_values[other.lower()] if other else int(number)
            if xor_values.get(name.lower()) != value:
                xor_values[name.lower()] = value
                changed = True
        if not changed:
            break

    # Rows carry protocol information. Scanning them a second time as plain
    # text would invent an HTTP entry for SOCKS addresses without a prefix.
    plain_text = "" if is_json else re.sub(r"<(tr|pre|code)\b[^>]*>.*?</\1>", "", text, flags=re.I | re.S)
    # Framework hydration scripts can repeat documentation examples. Only a
    # complete decoded address in a script is a standalone proxy entry.
    plain_text = re.sub(r"<script\b[^>]*>(.*?)</script>",
                        lambda match: match.group(1) if ADDRESS.fullmatch(match.group(1).strip()) else "",
                        plain_text, flags=re.I | re.S)
    for match in ADDRESS.finditer(plain_text):
        if len(found) >= limit:
            break
        protocol, credentials, host, port = match.groups()
        if not credentials:
            add(host, port, protocol or default_protocol)
    if "<tr" in text.lower() and len(found) < limit:
        for row in re.findall(r"<tr\b[^>]*>.*?</tr>", text, re.I | re.S):
            cell_markup = re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.I | re.S)
            cells = [unescape(re.sub(r"<[^>]*>", "", cell)).strip() for cell in cell_markup]
            protocols = []
            advertised = re.search(r'''data-protos\s*=\s*(['\"])(.*?)\1''', row, re.I | re.S)
            if advertised:
                protocols = [value.lower() for value in re.split(r"[^a-z0-9]+", advertised.group(2).lower())
                             if value.lower() in PROTOCOLS]
            if not protocols:
                protocols = [value for value in PROTOCOLS
                             if re.search(r"\b{}\b".format(re.escape(value.upper())),
                                          re.sub(r"<[^>]*>", " ", row), re.I)]
            if not protocols:
                protocols = [default_protocol]

            for encoded in re.findall(r'''\bdata-p\s*=\s*(["'])([A-Za-z0-9+/=_-]{12,128})\1''', row, re.I):
                try:
                    reversed_address = base64.b64decode(encoded[1] + "=" * (-len(encoded[1]) % 4),
                                                        validate=True).decode("ascii")
                    address = reversed_address[::-1]
                    address_match = ADDRESS.fullmatch(address)
                    if address_match:
                        address_protocol, credentials, host, port = address_match.groups()
                        if not credentials:
                            for row_protocol in protocols:
                                add(host, port, address_protocol or row_protocol)
                except (ValueError, UnicodeDecodeError):
                    pass

            if cells:
                first_ip = re.search(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", cells[0])
                if first_ip and xor_values:
                    script = " ".join(re.findall(r"<script\b[^>]*>(.*?)</script>", cell_markup[0], re.I | re.S))
                    digits = []
                    for left, right in re.findall(r"\(([a-z_]\w*)\s*\^\s*([a-z_]\w*)\)", script, re.I):
                        if left.lower() in xor_values and right.lower() in xor_values:
                            digits.append(str(xor_values[left.lower()] ^ xor_values[right.lower()]))
                    port = "".join(digits)
                    if port.isdigit() and 1 <= len(port) <= 5:
                        for row_protocol in protocols:
                            add(first_ip.group(0), port, row_protocol)
            for index, cell in enumerate(cells):
                for match in ADDRESS.finditer(cell):
                    protocol, credentials, host, port = match.groups()
                    if not credentials:
                        for row_protocol in protocols:
                            add(host, port, protocol or row_protocol)
                if index + 1 < len(cells) and cells[index + 1].isdigit():
                    host_match = re.search(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", cell)
                    host = host_match.group(0) if host_match else cell
                    for row_protocol in protocols:
                        add(host, cells[index + 1], row_protocol)
            if len(found) >= limit:
                break
    return list(found.values())
