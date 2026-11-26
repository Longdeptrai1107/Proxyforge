import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProxyEngine } from '../src/engine.mjs';
import { parseProxies } from '../src/parse.mjs';
import { createApp } from '../server.mjs';

const geo = { warning: null, async prepare() {}, lookup() { return { countryCode: 'VN', server: 'Test ISP', asn: 7552 }; } };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proxyforge-engine-'));
  const engine = new ProxyEngine(directory, { feeds: [], geo, autoEnabled: false, ...options });
  await engine.init();
  t.after(async () => { await engine.stop(); await rm(directory, { recursive: true, force: true }); });
  return engine;
}

test('checks force a fresh measurement, prune failures and persist server/country data', async (t) => {
  const calls = [];
  const engine = await fixture(t, { checker: async (proxy) => {
    calls.push(proxy.id);
    return { status: proxy.host === '8.8.8.8' ? 'alive' : 'dead', checkedAt: new Date().toISOString(), latencyMs: 10 };
  } });
  engine.addProxies(parseProxies('8.8.8.8:8080\n1.1.1.1:8080'));
  for (const proxy of engine.proxies.values()) Object.assign(proxy, { status: 'alive', checkMode: 'https', checkedAt: new Date().toISOString() });
  engine.check({ useCache: true });
  await engine.task;
  assert.equal(calls.length, 2);
  assert.equal(engine.proxies.size, 1);
  assert.equal(engine.job.removed, 1);
  assert.equal(engine.job.cached, 0);
  assert.equal(engine.list({ country: 'VN' }).rows[0].server, 'Test ISP');
  assert.equal(engine.list({ country: 'US' }).total, 0);
  const restored = new ProxyEngine(engine.dataDirectory, { feeds: [], geo, autoEnabled: false });
  await restored.init();
  assert.equal(restored.proxies.size, 1);
  assert.equal([...restored.proxies.values()][0].asn, 7552);
});

test('collection fetches four protocols under one source and rechecks old live proxies', async (t) => {
  const feeds = ['http', 'https', 'socks4', 'socks5'].map((protocol) => ({ url: 'https://example.com/' + protocol, protocol }));
  const calls = [];
  const engine = await fixture(t, { feeds: [{ id: 'fixture', publisher: 'fixture', url: feeds[0].url, protocol: 'http', feeds, enabled: true }],
    fetcher: async () => '8.8.8.8:1080', checker: async (proxy) => { calls.push(proxy.id); return { status: proxy.host === '9.9.9.9' ? 'dead' : 'alive' }; } });
  engine.addProxies(parseProxies('9.9.9.9:8080'));
  [...engine.proxies.values()][0].status = 'alive';
  engine.collect();
  await engine.task;
  assert.equal(calls.length, 5);
  assert(calls.includes('http://9.9.9.9:8080'));
  assert.equal(engine.job.removed, 1);
  assert.equal(engine.job.state, 'done');
  assert.deepEqual(new Set([...engine.proxies.values()].map(({ protocol }) => protocol)), new Set(['http', 'https', 'socks4', 'socks5']));
});

test('stopping a partial check retains unchecked old live and removes confirmed failures', async (t) => {
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const engine = await fixture(t, { checker: async (proxy, { signal }) => {
    if (proxy.host === '8.8.8.8') return { status: 'dead' };
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
  } });
  engine.addProxies(parseProxies('8.8.8.8:8080\n1.1.1.1:8080'));
  for (const proxy of engine.proxies.values()) proxy.status = 'alive';
  engine.check({ concurrency: 1 });
  await waiting;
  await engine.stop();
  assert.equal(engine.job.state, 'stopped');
  assert.equal(engine.proxies.size, 1);
  assert.equal(engine.outputProxies()[0].host, '1.1.1.1');
  assert([...engine.proxies.values()].every(({ status }) => status !== 'checking'));
});

test('checker errors settle every worker before unlocking and keep partial verified results', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const engine = await fixture(t, { checker: async (proxy) => {
    if (proxy.host === '8.8.8.8') throw new Error('checker failure');
    await waiting;
    return { status: 'dead' };
  } });
  engine.addProxies(parseProxies('8.8.8.8:8080\n1.1.1.1:8080'));
  for (const proxy of engine.proxies.values()) proxy.status = 'alive';
  engine.check({ concurrency: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert(engine.busy());
  release();
  await engine.task;
  assert.equal(engine.job.state, 'error');
  assert.equal(engine.job.active, 0);
  assert.equal(engine.proxies.size, 1);
  assert.equal(engine.outputProxies()[0].host, '8.8.8.8');
  assert([...engine.proxies.values()].every(({ status }) => status !== 'checking'));
});

test('failed location lookup preserves completed check results and stop releases a pending lookup', async (t) => {
  const engine = await fixture(t, { checker: async () => ({ status: 'alive' }),
    geo: { async prepare() { throw new Error('offline database'); } } });
  engine.addProxies(parseProxies('8.8.8.8:8080'));
  engine.check();
  await engine.task;
  assert.equal(engine.job.state, 'done');
  assert.equal(engine.snapshot().counts.alive, 1);
  assert.equal(engine.job.geoWarning, 'offline database');
  let started;
  const locating = new Promise((resolve) => { started = resolve; });
  engine.geo = { prepare() { started(); return new Promise(() => {}); } };
  engine.check();
  await locating;
  await engine.stop();
  assert.equal(engine.job.state, 'stopped');
  assert.equal(engine.proxies.size, 1);
});

test('Node API serves 249 countries and filters list/exports with server metadata', async (t) => {
  const engine = await fixture(t);
  engine.addProxies([{ host: '8.8.8.8', port: 8080, protocol: 'http', countryCode: 'VN', city: 'Hanoi', server: 'Test ISP', asn: 7552 },
    { host: '1.1.1.1', port: 1080, protocol: 'socks5', countryCode: 'US' }]);
  for (const proxy of engine.proxies.values()) proxy.status = 'alive';
  const app = await createApp({ engine });
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const countries = await (await fetch(origin + '/countries.json')).json();
  assert.equal(new Set(countries).size, 249);
  const filtered = await (await fetch(origin + '/api/proxies?country=VN')).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].server, 'Test ISP');
  const exported = await (await fetch(origin + '/api/export?format=json&status=all&country=VN')).json();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].city, 'Hanoi');
});
