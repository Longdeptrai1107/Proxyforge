import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { ProxyEngine } from '../src/engine.mjs';
import { parseProxies } from '../src/parse.mjs';
import { createApp } from '../server.mjs';

const source = { id: 'fixture', publisher: 'fixture', name: 'fixture', enabled: true, url: 'https://example.com/list', protocol: 'http' };
const geo = { async prepare() {}, lookup() { return { countryCode: 'VN', server: 'Test ISP' }; } };
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proxyforge-auto-'));
  const engine = new ProxyEngine(directory, { feeds: [source], geo, autoEnabled: false, ...options });
  await engine.init();
  t.after(async () => { await engine.stop(); await rm(directory, { recursive: true, force: true }); });
  return engine;
}

test('refresh bypasses feed cache, streams only HTTPS successes and retains old live until checked', { timeout: 5000 }, async (t) => {
  const started = gate(), release = gate();
  let fetched = 0;
  const engine = await fixture(t, { fetcher: async () => { fetched++; return '8.8.8.8:8080\n1.1.1.1:8080'; },
    checker: async (proxy, { mode, timeoutMs }) => {
      assert.equal(mode, 'https'); assert.equal(timeoutMs, 3000);
      if (proxy.host === '9.9.9.9') { started.resolve(); await release.promise; return { status: 'dead' }; }
      return { status: proxy.host === '8.8.8.8' ? 'alive' : 'handshake', latencyMs: 1 };
    } });
  engine.addProxies(parseProxies('9.9.9.9:8080'));
  engine.proxies.get('http://9.9.9.9:8080').status = 'alive';
  engine.cache.set(source.url, { time: Date.now(), text: '8.8.4.4:9090' });
  engine.refresh();
  try {
    await started.promise; await turn();
    assert.deepEqual(new Set(engine.outputProxies().map((p) => p.host)), new Set(['9.9.9.9', '8.8.8.8']));
    assert(engine.list().rows.every((p) => p.status === 'alive'));
  } finally { release.resolve(); await engine.task; }
  assert.equal(fetched, 1);
  assert.deepEqual(engine.outputProxies().map((p) => p.host), ['8.8.8.8']);
  assert.equal(engine.job.removed, 1);
  assert.equal(engine.job.liveAdded, 1);
  const saved = JSON.parse(await readFile(join(engine.dataDirectory, 'state.json'), 'utf8'));
  assert.deepEqual(saved.proxies.map((p) => p.status), ['alive']);
  assert.equal(engine.job.options.concurrency, 10000);
});

test('auto repeats without overlap and resumes on backend restart', { timeout: 5000 }, async (t) => {
  const first = gate(), second = gate(), release = gate();
  let fetched = 0, active = 0, maximum = 0;
  const engine = await fixture(t, { autoEnabled: true, autoIntervalMs: 40,
    fetcher: async () => { fetched++; return '8.8.8.8:8080'; }, checker: async () => {
      maximum = Math.max(maximum, ++active);
      try {
        if (fetched === 1) { first.resolve(); await release.promise; } else second.resolve();
        return { status: 'alive', latencyMs: 1 };
      } finally { active--; }
    } });
  try {
    await first.promise; await delay(90);
    assert.equal(fetched, 1);
    release.resolve(); await second.promise;
    await engine.stop();
    assert.equal(maximum, 1);
    assert.equal(engine.automation.enabled, false);
    assert.equal(engine.automation.nextRunAtMs, null);
    assert.equal(engine.busy(), false);
    const count = fetched;
    await delay(90); assert.equal(fetched, count);
    const restarted = gate();
    const restored = new ProxyEngine(engine.dataDirectory, { feeds: [source], geo,
      fetcher: async () => '8.8.8.8:8080', checker: async () => { restarted.resolve(); return { status: 'alive', latencyMs: 1 }; } });
    await restored.init();
    try {
      await restarted.promise;
      assert.equal(restored.automation.enabled, true);
      assert.equal(restored.liveOnly, true);
    } finally { await restored.stop(); }
    await engine.configureAuto();
    assert.equal(engine.automation.enabled, true);
    await engine.stop();
  } finally { release.resolve(); }
});

test('backend starts checking before any browser request, even when the saved session was paused', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxyforge-startup-'));
  await writeFile(join(directory, 'state.json'), JSON.stringify({ automation: { enabled: false } }));
  const checking = gate();
  const engine = new ProxyEngine(directory, { feeds: [source], geo, fetcher: async () => '8.8.8.8:8080',
    checker: async (proxy, { mode, timeoutMs }) => {
      assert.equal(mode, 'https'); assert.equal(timeoutMs, 3000);
      checking.resolve(); return { status: 'alive', latencyMs: 1 };
    } });
  await engine.init();
  const app = await createApp({ engine });
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    // No request is sent to the server to start automation.
    await checking.promise; await engine.task;
    assert.equal(engine.automation.enabled, true);
    assert.equal(engine.automation.intervalMs, 60000);
    assert.equal(engine.job.options.concurrency, 10000);
    assert.equal(engine.snapshot().counts.alive, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Stop keeps new verified live and old live whose recheck was interrupted', { timeout: 5000 }, async (t) => {
  const started = gate();
  const engine = await fixture(t, { fetcher: async () => '8.8.8.8:8080\n1.1.1.1:8080',
    checker: async (proxy, { signal }) => {
      if (proxy.host === '9.9.9.9') return { status: 'dead' };
      if (proxy.host === '8.8.8.8') return { status: 'alive', latencyMs: 1 };
      started.resolve();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    } });
  engine.addProxies(parseProxies('9.9.9.9:8080\n8.8.8.8:8080\n1.1.1.1:8080'));
  for (const proxy of engine.proxies.values()) proxy.status = 'alive';
  engine.refresh({ concurrency: 1 });
  await started.promise; await engine.stop();
  assert.equal(engine.job.state, 'stopped');
  assert.deepEqual(new Set(engine.outputProxies().map((p) => p.host)), new Set(['8.8.8.8', '1.1.1.1']));
  assert(engine.outputProxies().every((p) => p.status === 'alive'));
  assert.equal(engine.job.removed, 1);
});

test('10,000 probes run concurrently and additional candidates wait', { timeout: 10000 }, async (t) => {
  const ready = gate(), release = gate();
  let active = 0, maximum = 0, calls = 0;
  const engine = await fixture(t, {
    fetcher: async () => Array.from({ length: 10001 }, (_, index) => `8.8.8.8:${10000 + index}`).join('\n'),
    checker: async (proxy, { mode, timeoutMs }) => {
      assert.equal(mode, 'https'); assert.equal(timeoutMs, 3000);
      maximum = Math.max(maximum, ++active); calls++;
      if (active === 10000) ready.resolve();
      try { await release.promise; return { status: 'dead' }; } finally { active--; }
    } });
  engine.refresh({ concurrency: 10000 });
  try {
    await ready.promise;
    assert.equal(active, 10000); assert.equal(calls, 10000);
    assert.equal(engine.snapshot().limits.maxConcurrency, 10000);
  } finally { release.resolve(); await engine.task; }
  assert.equal(maximum, 10000);
  assert.equal(engine.job.networkChecked, 10001);
  assert.equal(engine.snapshot().counts.total, 0);
});

test('API auto/import output and exports contain verified live only', { timeout: 5000 }, async (t) => {
  const started = gate(), release = gate();
  const engine = await fixture(t, { fetcher: async () => '8.8.8.8:8080', checker: async (proxy, { mode, timeoutMs }) => {
    assert.equal(mode, 'https'); assert.equal(timeoutMs, 3000);
    started.resolve(); await release.promise;
    return { status: proxy.host === '8.8.8.8' ? 'alive' : 'dead', latencyMs: 1 };
  } });
  engine.liveOnly = true;
  const app = await createApp({ engine });
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await (await fetch(origin + '/api/state')).json();
  const post = (path, body = {}) => fetch(origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Proxy-Forge-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/import', { text: '8.8.8.8:8080\n1.1.1.1:8080' })).status, 200);
    await started.promise;
    assert.deepEqual(await (await fetch(origin + '/api/export?format=json&status=all')).json(), []);
    release.resolve(); await engine.task;
    const exported = await (await fetch(origin + '/api/export?format=json&status=all')).json();
    assert.deepEqual(exported.map((p) => p.status), ['alive']);
    const state = await (await post('/api/auto', { enabled: true })).json();
    assert.equal(state.automation.intervalMs, 60000);
    assert.deepEqual(state.automation.options, { limit: 100000, concurrency: 10000, timeoutMs: 3000 });
    const stopped = await (await post('/api/stop')).json();
    assert.equal(stopped.automation.enabled, false);
  } finally { release.resolve(); }
});
