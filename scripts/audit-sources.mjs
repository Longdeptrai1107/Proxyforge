import { mkdir, writeFile } from 'node:fs/promises';
import { SOURCES } from '../src/sources.mjs';
import { fetchFeed } from '../src/network.mjs';
import { parseProxies, proxyKey } from '../src/parse.mjs';

const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < SOURCES.length) {
    const source = SOURCES[cursor++];
    const start = performance.now();
    const entries = new Map(), errors = [];
    for (const feed of source.feeds ?? [source]) {
      try {
        const text = await fetchFeed(feed.url, { timeout: 12000 });
        const parsed = parseProxies(text, feed.protocol);
        for (const proxy of parsed) entries.set(proxyKey(proxy), proxy);
        if (!parsed.length) errors.push(`${feed.url}: no proxies`);
      } catch (error) { errors.push(`${feed.url}: ${error.message}`); }
    }
    const protocolCounts = {};
    for (const proxy of entries.values()) protocolCounts[proxy.protocol] = (protocolCounts[proxy.protocol] || 0) + 1;
    const result = { ...source, ok: entries.size > 0, count: entries.size, protocolCounts, errors,
      durationMs: Math.round(performance.now() - start) };
    results.push(result);
    console.log(`${results.length}/${SOURCES.length} ${source.name}: ${result.count || errors.join('; ') || 'empty'}`);
  }
}));
const protocolCounts = {};
for (const result of results) for (const [protocol, count] of Object.entries(result.protocolCounts)) {
  protocolCounts[protocol] = (protocolCounts[protocol] || 0) + count;
}
const summary = { total: results.length, ok: results.filter((r) => r.ok).length, protocolCounts };
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/source-audit-node.json', import.meta.url), JSON.stringify({
  checkedAt: new Date().toISOString(),
  scope: 'HTTPS download and valid-address parsing; proxy reachability requires Check.',
  summary, results: results.sort((a, b) => a.id.localeCompare(b.id)),
}, null, 2));
console.log(JSON.stringify(summary));
