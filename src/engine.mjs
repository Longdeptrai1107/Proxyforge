import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchFeed, validateFeedURL } from './network.mjs';
import { parseProxies, proxyKey, PROTOCOLS } from './parse.mjs';
import { checkProxy } from './checker.mjs';
import { SOURCES } from './sources.mjs';
import { GeoLookup } from './geo.mjs';

export const MAX_PROXIES = 100000;
export const MAX_CONCURRENCY = 10000;
export const AUTO_INTERVAL_MS = 60000;
const integer = (value, min, max, fallback) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;

export class ProxyEngine extends EventEmitter {
  constructor(dataDirectory, { feeds = SOURCES, fetcher = fetchFeed, checker = checkProxy, geo = new GeoLookup(dataDirectory),
    autoEnabled = true, autoIntervalMs = AUTO_INTERVAL_MS } = {}) {
    super();
    this.dataDirectory = dataDirectory;
    this.fetcher = fetcher;
    this.checker = checker;
    this.geo = geo;
    this.sources = feeds.map((feed) => ({ ...feed, status: 'idle', count: 0, durationMs: null, error: null }));
    this.proxies = new Map();
    this.cache = new Map();
    this.job = null;
    this.controller = null;
    this.revision = 0;
    this.saveChain = Promise.resolve();
    this.automation = { enabled: autoEnabled !== false, intervalMs: autoIntervalMs, nextRunAtMs: null,
      lastRunAtMs: null, rounds: 0, error: null, options: this.autoOptions() };
    this.liveOnly = true;
    this.autoGeneration = 0;
    this.autoTimer = null;
  }
  async init() {
    if (this.initialized) return;
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.dataDirectory, 'state.json'), 'utf8'));
      // Pausing affects the running process; every backend startup runs automatically.
      this.automation.options = this.autoOptions(saved.automation?.options);
      const known = new Map((saved.sources ?? []).map((source) => [source.id, source]));
      for (const source of this.sources) {
        const old = known.get(source.id);
        if (old) Object.assign(source, {
          enabled: old.enabled !== false, status: old.status === 'fetching' ? 'idle' : old.status,
          count: old.count ?? 0, error: old.error ?? null, fetchedAt: old.fetchedAt, durationMs: old.durationMs,
        });
      }
      for (const custom of saved.sources ?? []) {
        if (!custom.custom || this.sources.some(({ id }) => id === custom.id)) continue;
        try {
          validateFeedURL(custom.url);
          this.sources.push({ ...custom, status: 'idle' });
        } catch { /* Invalid saved custom source is ignored. */ }
      }
      for (const proxy of (saved.proxies ?? []).slice(0, MAX_PROXIES)) {
        const parsed = parseProxies(proxyKey(proxy), proxy.protocol, { limit: 1 })[0];
        if (!parsed) continue;
        const restored = { ...proxy, ...parsed, id: proxyKey(parsed) };
        if (restored.status === 'checking') restored.status = 'pending';
        this.proxies.set(restored.id, restored);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadWarning = 'Không đọc được phiên cũ; đã tạo phiên mới.';
    }
    this.initialized = true;
    if (this.automation.enabled) this.scheduleAuto(0);
  }
  autoOptions(options = {}) {
    return { limit: integer(options.limit, 1, MAX_PROXIES, MAX_PROXIES),
      concurrency: integer(options.concurrency, 1, MAX_CONCURRENCY, 10000), timeoutMs: 3000 };
  }
  async configureAuto({ enabled = true, ...options } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Trạng thái tự động không hợp lệ.');
    if (!enabled) { await this.stop(); return this.snapshot(); }
    if (!this.sources.some((source) => source.enabled)) throw new Error('Hãy bật ít nhất một nguồn.');
    this.automation.enabled = true;
    this.automation.error = null;
    this.automation.options = this.autoOptions(options);
    this.liveOnly = true;
    if (!this.autoTimer && !this.autoRunning) this.scheduleAuto(0);
    this.touch();
    await this.save();
    return this.snapshot();
  }
  scheduleAuto(delay) {
    clearTimeout(this.autoTimer);
    this.automation.nextRunAtMs = Date.now() + delay;
    const generation = this.autoGeneration;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      this.autoRunning = this.runAuto(generation).catch((error) => {
        this.automation.error = String(error.message).slice(0, 180);
        if (this.automation.enabled && generation === this.autoGeneration) this.scheduleAuto(this.automation.intervalMs);
      }).finally(() => { this.autoRunning = null; });
    }, delay);
    this.autoTimer.unref();
    this.touch();
  }
  async runAuto(generation) {
    if (this.busy()) await this.task.catch(() => {});
    if (!this.automation.enabled || generation !== this.autoGeneration) return;
    const started = Date.now();
    Object.assign(this.automation, { lastRunAtMs: started, nextRunAtMs: null, error: null });
    try {
      this.refresh(this.automation.options);
      await this.task;
      this.automation.rounds++;
      this.automation.error = this.job.error ?? null;
    } catch (error) { this.automation.error = String(error.message).slice(0, 180); }
    if (this.automation.enabled && generation === this.autoGeneration) {
      this.scheduleAuto(Math.max(0, started + this.automation.intervalMs - Date.now()));
      await this.save();
    }
  }
  outputProxies() { return [...this.proxies.values()].filter((proxy) => proxy.status === 'alive'); }
  busy() { return !!this.job && this.job.state === 'running'; }
  assertIdle() { if (this.busy()) throw new Error('Một tác vụ đang chạy. Hãy dừng trước khi đổi dữ liệu.'); }
  touch() { this.revision++; this.emit('change'); }
  snapshot() {
    const output = this.outputProxies();
    const counts = { total: output.length, pending: 0, checking: 0, alive: 0, handshake: 0, dead: 0 };
    let latency = 0;
    let measured = 0;
    const protocolCounts = Object.fromEntries(PROTOCOLS.map((protocol) => [protocol, 0]));
    const countryCounts = {};
    for (const proxy of output) {
      protocolCounts[proxy.protocol]++;
      const country = proxy.countryCode || 'unknown';
      countryCounts[country] = (countryCounts[country] || 0) + 1;
      if (counts[proxy.status] !== undefined) counts[proxy.status]++;
      if (proxy.status === 'alive') { latency += proxy.latencyMs; measured++; }
    }
    const enabled = this.sources.filter(({ enabled }) => enabled);
    const elapsedMs = this.job
      ? Math.max(1, (this.job.finishedAtMs ?? Date.now()) - this.job.startedAtMs) : 0;
    const job = this.job ? {
      ...this.job, elapsedMs,
      rate: this.job.networkChecked ? Math.round(this.job.networkChecked / (elapsedMs / 1000)) : 0,
    } : null;
    if (job) {
      job.etaSeconds = job.state === 'running' && ['check', 'recheck'].includes(job.phase) && job.rate > 0
        ? Math.ceil((job.total - job.completed) / job.rate) : null;
    }
    return {
      revision: this.revision, counts, job, protocolCounts, countryCounts,
      automation: { ...this.automation }, liveOnly: this.liveOnly,
      latencyMs: measured ? Math.round(latency / measured) : null,
      sources: {
        total: this.sources.length, enabled: enabled.length,
        publishers: new Set(this.sources.map(({ publisher }) => publisher)).size,
        domains: new Set(this.sources.map(({ url }) => new URL(url).hostname)).size,
        ok: this.sources.filter(({ status }) => status === 'ok').length,
        failed: this.sources.filter(({ status }) => status === 'error').length,
      },
      limits: { maxProxies: MAX_PROXIES, maxConcurrency: MAX_CONCURRENCY },
      warning: this.loadWarning ?? null,
    };
  }
  startJob(type, total, options) {
    this.assertIdle();
    this.controller = new AbortController();
    this.job = {
      id: randomUUID(), type, state: 'running', total, completed: 0,
      startedAtMs: Date.now(), networkChecked: 0, cached: 0, errors: 0,
      added: 0, duplicates: 0, removed: 0, liveAdded: 0, phase: type, active: 0, options,
    };
    this.touch();
    return this.controller.signal;
  }
  async endJob(error) {
    this.job.state = error ? 'error' : this.controller.signal.aborted ? 'stopped' : 'done';
    this.job.finishedAtMs = Date.now();
    if (error) this.job.error = error.message;
    this.job.active = 0;
    this.touch();
    await this.save();
  }
  async stop({ disableAuto = true } = {}) {
    if (disableAuto) this.automation.enabled = false;
    this.automation.nextRunAtMs = null;
    this.autoGeneration++;
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    if (this.busy()) this.controller.abort();
    this.touch();
    if (this.task) await this.task;
    if (this.autoRunning) await this.autoRunning;
    await this.save();
  }
  addProxies(proxies, source, max = MAX_PROXIES, inventory = this.proxies) {
    let added = 0;
    let duplicates = 0;
    for (const proxy of proxies) {
      const key = proxyKey(proxy);
      const existing = inventory.get(key);
      if (existing) {
        duplicates++;
        for (const field of ['countryCode', 'country', 'city', 'region', 'server', 'asn', 'locationSource', 'locationApproximate']) {
          if (proxy[field] != null) existing[field] = proxy[field];
        }
        if (source && !existing.sources.includes(source)) existing.sources.push(source);
      } else if (inventory.size < max) {
        inventory.set(key, {
          ...proxy, id: key, sources: source ? [source] : [], status: 'pending',
          latencyMs: null, checkedAt: null, error: null, exitIP: null,
        });
        added++;
      }
    }
    return { added, duplicates };
  }
  collect(options = {}) {
    return this.refresh({ limit: options.limit, concurrency: this.automation.options.concurrency });
  }
  async fetchSources(selected, { max, concurrency = 8, timeout = 12000, signal, inventory = this.proxies, fresh = false }) {
      let next = 0;
      const worker = async () => {
        while (next < selected.length && !signal.aborted) {
          const source = selected[next++];
          source.status = 'fetching';
          source.error = null;
          this.job.active++;
          this.touch();
          const started = performance.now();
          try {
            const entries = new Map();
            source.feedErrors = [];
            for (const feed of source.feeds ?? [source]) {
              if (signal.aborted) break;
              try {
                const cached = this.cache.get(feed.url);
                const text = !fresh && cached && Date.now() - cached.time < 5 * 60 * 1000
                  ? cached.text : await this.fetcher(feed.url, { signal, timeout });
                this.cache.set(feed.url, { time: Date.now(), text });
                while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
                for (const proxy of parseProxies(text, feed.protocol)) entries.set(proxyKey(proxy), proxy);
              } catch (error) { source.feedErrors.push(String(error.message).slice(0, 160)); }
            }
            if (signal.aborted) { source.status = 'idle'; return; }
            const proxies = [...entries.values()];
            if (!proxies.length) throw new Error(source.feedErrors[0] || 'Không có proxy hợp lệ trong phản hồi.');
            const result = this.addProxies(proxies, source.id, max, inventory);
            this.job.added += result.added;
            this.job.duplicates += result.duplicates;
            Object.assign(source, { status: 'ok', count: proxies.length, fetchedAt: new Date().toISOString() });
          } catch (error) {
            source.status = signal.aborted ? 'idle' : 'error';
            source.error = signal.aborted ? null : String(error.message).slice(0, 180);
            if (!signal.aborted) this.job.errors++;
          } finally {
            source.durationMs = Math.round(performance.now() - started);
            this.job.completed++;
            this.job.active--;
            this.touch();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  }
  refresh(options = {}) {
    this.assertIdle();
    const selected = this.sources.filter((source) => source.enabled);
    if (!selected.length) throw new Error('Hãy bật ít nhất một nguồn.');
    const settings = this.autoOptions(options);
    const candidates = new Map([...this.proxies].map(([id, proxy]) => [id, { ...proxy, sources: [...(proxy.sources ?? [])] }]));
    this.liveOnly = true;
    this.proxies = new Map([...this.proxies].filter(([, proxy]) => proxy.status === 'alive'));
    const signal = this.startJob('refresh', selected.length, { ...settings, mode: 'https' });
    this.job.phase = 'collect';
    this.task = (async () => {
      await this.fetchSources(selected, { max: settings.limit, signal, inventory: candidates, fresh: true });
      if (signal.aborted) return;
      this.job.total += candidates.size;
      this.job.phase = 'check'; this.touch();
      await this.measure([...candidates.values()], { mode: 'https', concurrency: settings.concurrency,
        timeoutMs: 3000, signal });
    })().then(() => this.endJob(), (error) => this.endJob(error));
    return this.snapshot();
  }
  check(options = {}) {
    this.assertIdle();
    const mode = 'https';
    const concurrency = integer(options.concurrency, 1, MAX_CONCURRENCY, 10000);
    const timeoutMs = 3000;
    const protocols = Array.isArray(options.protocols) ? options.protocols.filter((p) => PROTOCOLS.includes(p)) : PROTOCOLS;
    let candidates = [...this.proxies.values()].filter((p) => protocols.includes(p.protocol) &&
      (options.scope !== 'pending' || p.status === 'pending'));
    if (!candidates.length) throw new Error('Chưa có proxy phù hợp. Hãy thu thập hoặc nhập danh sách.');
    candidates = candidates.map((proxy) => ({ ...proxy, sources: [...(proxy.sources ?? [])] }));
    this.proxies = new Map([...this.proxies].filter(([, proxy]) => proxy.status === 'alive'));
    const signal = this.startJob('check', candidates.length, { mode, concurrency, timeoutMs });
    this.task = this.measure(candidates, { mode, concurrency, timeoutMs, signal })
      .then(() => this.endJob(), (error) => this.endJob(error));
    return this.snapshot();
  }
  async measure(candidates, { mode, concurrency, timeoutMs, signal }) {
      let next = 0;
      let yieldedAt = performance.now();
      const worker = async () => {
        while (next < candidates.length && !signal.aborted) {
          const proxy = candidates[next++];
          {
            const previous = proxy.status;
            proxy.status = 'checking';
            this.job.active++;
            let result;
            try { result = await this.checker(proxy, { mode, timeoutMs, signal }); }
            catch (error) { proxy.status = previous; throw error; }
            finally { this.job.active--; }
            if (result.status === 'cancelled') proxy.status = previous;
            else {
              Object.assign(proxy, { exitIP: null, ...result, checkMode: mode, checkTimeoutMs: timeoutMs });
              this.job.networkChecked++;
              this.job.completed++;
              if (result.status === 'alive') {
                if (!this.proxies.has(proxy.id)) this.job.liveAdded++;
                this.proxies.set(proxy.id, proxy);
              } else {
                if (this.proxies.delete(proxy.id)) this.job.removed++;
                this.job.errors++;
              }
            }
            this.touch();
          }
          // Keep HTTP and the stop button responsive during large check runs.
          if (performance.now() - yieldedAt > 12) {
            await new Promise((resolve) => setImmediate(resolve));
            yieldedAt = performance.now();
          }
        }
      };
      const measured = await Promise.allSettled(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
      const rejected = measured.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (signal.aborted) return;
       const live = candidates.filter((proxy) => proxy.status === 'alive');
      if (live.length) {
        this.job.phase = 'location'; this.touch();
        try {
          let onAbort;
          try {
            await Promise.race([this.geo.prepare(), new Promise((resolve) => {
              onAbort = resolve;
              signal.addEventListener('abort', onAbort, { once: true });
            })]);
          } finally { signal.removeEventListener('abort', onAbort); }
          if (this.geo.warning) this.job.geoWarning = this.geo.warning;
          if (!signal.aborted) for (const proxy of live) {
            const metadata = this.geo.lookup(proxy.host);
            if (metadata.countryCode && (!proxy.countryCode || proxy.locationSource?.startsWith('IPtoASN'))) {
              proxy.countryCode = metadata.countryCode; proxy.locationSource = metadata.locationSource;
            }
            for (const [field, value] of Object.entries(metadata)) if (!proxy[field]) proxy[field] = value;
          }
        } catch (error) { this.job.geoWarning = String(error.message).slice(0, 160); }
      }
      this.touch();
  }
  async import(text, protocol = 'http') {
    this.assertIdle();
    if (!PROTOCOLS.includes(protocol)) throw new Error('Giao thức không hợp lệ.');
    const parsed = parseProxies(text, protocol);
    if (!parsed.length) throw new Error('Không tìm thấy IP công khai và cổng hợp lệ.');
    const result = this.addProxies(parsed, 'manual');
    this.check({ concurrency: this.automation.options.concurrency });
    this.touch();
    await this.save();
    return { ...result, parsed: parsed.length, ...this.snapshot() };
  }
  async updateSources(ids, enabled) {
    this.assertIdle();
    if (!Array.isArray(ids) || typeof enabled !== 'boolean') throw new Error('Cấu hình nguồn không hợp lệ.');
    const selected = new Set(ids);
    for (const source of this.sources) if (selected.has(source.id)) source.enabled = enabled;
    this.touch();
    await this.save();
  }
  async addSource({ url, name, protocol = 'http' }) {
    this.assertIdle();
    const parsed = validateFeedURL(url);
    if (!PROTOCOLS.includes(protocol)) throw new Error('Giao thức nguồn không hợp lệ.');
    if (this.sources.length >= 500) throw new Error('Tối đa 500 nguồn.');
    if (this.sources.some((source) => source.url === parsed.href)) throw new Error('Nguồn đã có trong danh sách.');
    this.sources.push({
      id: `custom-${randomUUID()}`, url: parsed.href, name: String(name || parsed.hostname).slice(0, 80),
      publisher: parsed.hostname, protocol, homepage: parsed.origin,
      enabled: true, custom: true, status: 'idle', count: 0, error: null,
    });
    this.touch();
    await this.save();
  }
  async clear() {
    this.assertIdle();
    this.proxies.clear();
    this.job = null;
    this.touch();
    await this.save();
  }
  list({ search = '', status = 'all', protocol = 'all', country = 'all', sort = 'latency', page = 1, pageSize = 50 } = {}) {
    let rows = this.outputProxies();
    if (search) {
      const query = String(search).toLowerCase().slice(0, 100);
      rows = rows.filter((p) => ['id', 'exitIP', 'server', 'asn', 'countryCode', 'country', 'city'].some((field) => String(p[field] ?? '').toLowerCase().includes(query)));
    }
    if (status !== 'all') rows = rows.filter((p) => p.status === status);
    if (protocol !== 'all') rows = rows.filter((p) => p.protocol === protocol);
    if (country !== 'all') rows = rows.filter((p) => (p.countryCode || 'unknown').toUpperCase() === country.toUpperCase());
    if (sort === 'latency') rows.sort((a, b) => {
      const rank = (p) => p.status === 'alive' ? 0 : p.status === 'handshake' ? 1 : 2;
      return rank(a) - rank(b) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    });
    pageSize = integer(pageSize, 1, 200, 50);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = integer(page, 1, pages, 1);
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, pages, page, pageSize };
  }
  save() {
    const content = JSON.stringify({ version: 1, sources: this.sources, automation: this.automation,
      liveOnly: this.liveOnly, proxies: this.outputProxies() });
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      const temp = join(this.dataDirectory, 'state.tmp');
      await writeFile(temp, content, 'utf8');
      await rename(temp, join(this.dataDirectory, 'state.json'));
    });
    this.saveChain.catch((error) => {
      this.loadWarning = `Không lưu được phiên: ${error.message}`;
      this.touch();
    });
    return this.saveChain;
  }
}
