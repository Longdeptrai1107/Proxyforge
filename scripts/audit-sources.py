"""Audit catalog URLs with the same safe downloader and parser as collection."""

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from proxyforge.feeds import feed_session, fetch_feed
from proxyforge.parsing import parse_proxies

sys.stdout.reconfigure(encoding="utf-8")


async def audit(catalog, output):
    sources = json.loads(catalog.read_text(encoding="utf-8"))
    queue = asyncio.Queue()
    for source in sources:
        queue.put_nowait(source)
    results = []
    async with feed_session() as session:
        async def worker():
            while not queue.empty():
                source = queue.get_nowait()
                started = time.perf_counter()
                feeds = source.get("feeds") or [{"url": source["url"], "protocol": source["protocol"]}]
                entries, errors = {}, []
                for feed in feeds:
                    try:
                        text = await fetch_feed(session, feed["url"], timeout_ms=12000)
                        parsed = parse_proxies(text, feed["protocol"])
                        for proxy in parsed:
                            entries[(proxy["protocol"], proxy["host"], proxy["port"])] = proxy
                        if not parsed:
                            errors.append(feed["url"] + ": no proxies")
                    except Exception as error:
                        errors.append(feed["url"] + ": " + (str(error) or type(error).__name__))
                result = {**source, "ok": bool(entries), "count": len(entries),
                          "protocolCounts": dict(Counter(p["protocol"] for p in entries.values())),
                          "errors": errors, "durationMs": round((time.perf_counter() - started) * 1000)}
                results.append(result)
                print("{}/{} {}: {} {}".format(len(results), len(sources), source["name"],
                                               result["count"], result["protocolCounts"] or errors), flush=True)
        await asyncio.gather(*(worker() for _ in range(min(8, len(sources)))))
    output.parent.mkdir(parents=True, exist_ok=True)
    summary = {"total": len(results), "ok": sum(result["ok"] for result in results),
               "protocolCounts": dict(sum((Counter(result["protocolCounts"]) for result in results), Counter()))}
    output.write_text(json.dumps({"checkedAt": datetime.now(timezone.utc).isoformat(),
                                  "scope": "HTTPS download and valid-address parsing; proxy reachability requires Check.",
                                  "summary": summary,
                                  "results": sorted(results, key=lambda item: item["id"])},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", nargs="?", type=Path,
                        default=Path(__file__).resolve().parent.parent / "proxyforge" / "sources.json")
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parent.parent / "data" / "source-audit.json")
    options = parser.parse_args()
    asyncio.run(audit(options.catalog, options.output))
