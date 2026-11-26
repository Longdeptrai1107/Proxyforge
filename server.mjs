import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { ProxyEngine } from './src/engine.mjs';
import { CHECK_URL } from './src/checker.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const assets = new Map([
  ['/', ['index.html', '.html']], ['/styles.css', ['styles.css', '.css']],
  ['/app.js', ['app.js', '.js']], ['/favicon.svg', ['favicon.svg', '.svg']],
  ['/countries.json', ['countries.json', '.json']],
]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Yêu cầu JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Dữ liệu nhập tối đa 8 MB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON không hợp lệ.'); }
}

function csv(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportProxies(res, engine, params) {
  const format = ['txt', 'json', 'csv'].includes(params.get('format')) ? params.get('format') : 'txt';
  const status = params.get('status') ?? 'alive';
  const protocol = params.get('protocol') ?? 'all';
  const bare = params.get('bare') === '1';
  const country = (params.get('country') ?? 'all').toUpperCase();
  const rows = engine.outputProxies().filter((proxy) =>
    (status === 'all' || proxy.status === status) && (protocol === 'all' || proxy.protocol === protocol) &&
    (country === 'ALL' || (proxy.countryCode || 'UNKNOWN').toUpperCase() === country));
  const contentType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
  res.writeHead(200, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Content-Disposition': `attachment; filename="proxy-forge-${status}-${Date.now()}.${format}"`,
    'Cache-Control': 'no-store',
  });
  const write = async (chunk) => {
    if (res.destroyed) throw new Error('Tải xuống đã đóng.');
    if (!res.write(chunk)) await once(res, 'drain');
  };
  if (format === 'json') await write('[\n');
  if (format === 'csv') await write('protocol,host,port,status,latency_ms,exit_ip,checked_at,error,country_code,country,city,server,asn\r\n');
  for (let start = 0; start < rows.length; start += 500) {
    const part = rows.slice(start, start + 500).map((proxy, index) => {
      if (format === 'json') return `${start + index ? ',\n' : ''}${JSON.stringify(proxy)}`;
      if (format === 'csv') return [proxy.protocol, proxy.host, proxy.port, proxy.status, proxy.latencyMs,
        proxy.exitIP, proxy.checkedAt, proxy.error, proxy.countryCode, proxy.country, proxy.city, proxy.server, proxy.asn].map(csv).join(',') + '\r\n';
      return `${bare ? proxy.id.slice(proxy.id.indexOf('://') + 3) : proxy.id}\n`;
    }).join('');
    await write(part);
  }
  res.end(format === 'json' ? '\n]\n' : '');
}

export async function createApp({ dataDirectory = process.env.PROXYFORGE_DATA || join(directory, 'data'), engine: suppliedEngine } = {}) {
  const engine = suppliedEngine ?? new ProxyEngine(dataDirectory);
  if (!suppliedEngine) await engine.init();
  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    // Loopback binding plus Host/Origin checks prevent other sites and DNS
    // rebinding from using this local service as a network scanner.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '')) {
      return json(res, 403, { error: 'Host không được phép.' });
    }
    const ownOrigin = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== ownOrigin) return json(res, 403, { error: 'Origin không được phép.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Yêu cầu khác nguồn bị từ chối.' });
    try {
      const url = new URL(req.url, ownOrigin);
      const path = url.pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [name, extension] = assets.get(path);
        const content = await readFile(join(directory, 'public', name));
        res.writeHead(200, { 'Content-Type': `${extension === '.json' ? 'application/json' : mime[extension]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/api/state') {
        return json(res, 200, { ...engine.snapshot(), token, checkURL: CHECK_URL });
      }
      if (req.method === 'GET' && path === '/api/sources') return json(res, 200, engine.sources);
      if (req.method === 'GET' && path === '/api/proxies') return json(res, 200, engine.list(Object.fromEntries(url.searchParams)));
      if (req.method === 'GET' && path === '/api/export') return await exportProxies(res, engine, url.searchParams);
      if (req.method === 'GET' && path === '/api/events') {
        if (clients.size >= 16) return json(res, 429, { error: 'Quá nhiều kết nối tiến độ.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Không tìm thấy.' });
      if (req.headers['x-proxy-forge-token'] !== token) return json(res, 403, { error: 'Phiên không hợp lệ. Hãy tải lại trang.' });
      const input = await body(req);
      if (path === '/api/collect') return json(res, 202, engine.collect(input));
      if (path === '/api/auto') return json(res, 200, await engine.configureAuto(input));
      if (path === '/api/refresh') return json(res, 202, engine.refresh(input));
      if (path === '/api/check') return json(res, 202, engine.check(input));
      if (path === '/api/stop') { await engine.stop({ disableAuto: input.preserveAuto !== true }); return json(res, 200, engine.snapshot()); }
      if (path === '/api/import') {
        if (typeof input.text !== 'string') throw new Error('Danh sách proxy phải là văn bản.');
        return json(res, 200, await engine.import(input.text, input.protocol));
      }
      if (path === '/api/clear') { await engine.clear(); return json(res, 200, engine.snapshot()); }
      if (path === '/api/sources/toggle') {
        await engine.updateSources(input.ids, input.enabled);
        return json(res, 200, engine.snapshot());
      }
      if (path === '/api/sources/add') { await engine.addSource(input); return json(res, 201, engine.snapshot()); }
      return json(res, 404, { error: 'Không tìm thấy.' });
    } catch (error) {
      if (!res.headersSent) json(res, engine.busy() ? 409 : 400, { error: error.message });
      else res.destroy();
    }
  });
  let revision = -1;
  let heartbeat = 0;
  const broadcast = setInterval(() => {
    if (!clients.size) return;
    if (revision === engine.revision && !engine.busy() && ++heartbeat < 30) return;
    heartbeat = 0;
    revision = engine.revision;
    const event = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 256 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(event);
    }
  }, 500);
  broadcast.unref();
  server.on('close', () => clearInterval(broadcast));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, engine, close: async () => {
    await engine.stop({ disableAuto: false });
    for (const client of clients) client.end();
    if (engine.task) await engine.task;
    await engine.save();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const app = await createApp();
  app.server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Cổng ${port} đang được dùng. Đặt PORT để đổi cổng.` : error.message);
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`Proxy Forge: http://127.0.0.1:${port}`));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
