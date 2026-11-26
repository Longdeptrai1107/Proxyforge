"""Local ASN/server and IP-country lookup, with cached public datasets."""

import asyncio
import csv
import gzip
import ipaddress
import os
import time
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


class GeoLookup:
    def __init__(self, data_directory):
        self.directory = Path(data_directory) / "geo"
        self.tables = {}
        self.countries = {}
        self.loaded_at = 0
        self._loading = None
        self.warning = None

    async def prepare(self):
        if self.loaded_at and time.time() - self.loaded_at < 7 * 86400:
            return
        if self._loading is None:
            self._loading = asyncio.create_task(self._prepare())
        # A stopped check must not cancel a download thread and let the next
        # check write to the same temporary database files concurrently.
        await asyncio.shield(self._loading)

    async def _prepare(self):
        try:
            tables, countries, warnings = await asyncio.to_thread(self._load)
            self.tables = tables or self.tables
            self.countries = countries or self.countries
            self.warning = "; ".join(warnings) or None
            if self.tables or self.countries:
                self.loaded_at = time.time()
        finally:
            self._loading = None

    def _cached(self, path, url, reader, max_age):
        if not path.exists() or time.time() - path.stat().st_mtime > max_age:
            temporary = path.with_suffix(".download")
            try:
                request = Request(url, headers={"User-Agent": "ProxyForge/1.0 (local IP database)"})
                with urlopen(request, timeout=20) as response, temporary.open("wb") as output:
                    size = 0
                    while chunk := response.read(65536):
                        size += len(chunk)
                        if size > 32 * 1024 * 1024:
                            raise ValueError("IP database exceeds 32 MB.")
                        output.write(chunk)
                table = reader(temporary)
                os.replace(temporary, path)
                return table
            except (OSError, ValueError, EOFError):
                temporary.unlink(missing_ok=True)
                if not path.exists():
                    raise
        return reader(path)

    @staticmethod
    def _read_asn(path, version):
        starts, ends, values, networks = [], [], [], {}
        with gzip.open(path, "rt", encoding="utf-8") as rows:
            for line in rows:
                start, end, asn, country, description = line.rstrip("\n").split("\t", 4)
                starts.append(int(start) if version == 4 else int(ipaddress.ip_address(start)))
                ends.append(int(end) if version == 4 else int(ipaddress.ip_address(end)))
                if starts[-1] > ends[-1] or len(starts) > 1 and starts[-1] <= ends[-2]:
                    raise ValueError("Invalid ASN ranges.")
                values.append(networks.setdefault((asn, country), {
                    "asn": int(asn) or None, "server": description if int(asn) else None,
                    "countryCode": country if len(country) == 2 and country != "ZZ" else None,
                    "locationSource": "IPtoASN (ASN registration)", "locationApproximate": True,
                }))
        if not starts:
            raise ValueError("Empty ASN database.")
        return starts, ends, values

    @staticmethod
    def _read_countries(path):
        tables = {4: ([], [], []), 6: ([], [], [])}
        with gzip.open(path, "rt", encoding="utf-8") as rows:
            for start, end, country in csv.reader(rows):
                first, last = ipaddress.ip_address(start), ipaddress.ip_address(end)
                starts, ends, values = tables[first.version]
                if first.version != last.version or int(first) > int(last) or starts and int(first) <= ends[-1]:
                    raise ValueError("Invalid country ranges.")
                starts.append(int(first)); ends.append(int(last)); values.append(country)
        if not tables[4][0] or not tables[6][0]:
            raise ValueError("Empty country database.")
        return tables

    def _load(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        tables, countries, warnings = {}, {}, []
        for version, filename in ((4, "ip2asn-v4-u32.tsv.gz"), (6, "ip2asn-v6.tsv.gz")):
            try:
                tables[version] = self._cached(self.directory / filename, "https://iptoasn.com/data/" + filename,
                                               lambda path: self._read_asn(path, version), 7 * 86400)
            except (OSError, ValueError, EOFError) as error:
                warnings.append("ASN IPv{}: {}".format(version, str(error)[:80]))
        filename = "dbip-country-lite-{}.csv.gz".format(datetime.now(timezone.utc).strftime("%Y-%m"))
        try:
            countries = self._cached(self.directory / filename, "https://download.db-ip.com/free/" + filename,
                                     self._read_countries, 32 * 86400)
        except (OSError, ValueError, EOFError) as error:
            warnings.append("Quốc gia DB-IP: " + str(error)[:80])
            for cached in sorted(self.directory.glob("dbip-country-lite-*.csv.gz"), reverse=True):
                try:
                    countries = self._read_countries(cached)
                    break
                except (OSError, ValueError, EOFError):
                    continue
        return tables, countries, warnings

    def lookup(self, address):
        result = {"asn": None, "server": None, "countryCode": None,
                  "locationSource": None, "locationApproximate": True}
        try:
            ip = ipaddress.ip_address(address)
            table = self.tables.get(ip.version)
            if table:
                starts, ends, values = table
                index = bisect_right(starts, int(ip)) - 1
                if index >= 0 and int(ip) <= ends[index]:
                    result.update(values[index])
            country_table = self.countries.get(ip.version)
            if country_table:
                starts, ends, countries = country_table
                index = bisect_right(starts, int(ip)) - 1
                if index >= 0 and int(ip) <= ends[index] and countries[index] not in ("ZZ", "XX"):
                    result.update(countryCode=countries[index], locationSource="DB-IP Lite")
        except ValueError:
            pass
        return result
