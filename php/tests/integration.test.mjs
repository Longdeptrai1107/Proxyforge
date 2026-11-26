import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || (existsSync('C:/xampp/php/php.exe') ? 'C:/xampp/php/php.exe' : 'php');
const openssl = process.env.OPENSSL_BINARY || (existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
const browser = [process.env.PROXYFORGE_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((path) => path && existsSync(path));

const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
async function invoke(script, input, env = {}) {
  const child = spawn(php, [join(root, 'tests', script)], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input ? JSON.stringify(input) : undefined);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr || stdout);
  assert.equal(stderr, '', stderr);
  return stdout;
}

test('native PHP checker verifies HTTP, HTTPS, SOCKS4a, SOCKS5, TLS failures, invalid bodies and total 3s timeout', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-php-network-'));
  const servers = []; const sockets = new Set();
  try {
    const keyPath = join(directory, 'key.pem'); const certPath = join(directory, 'certificate.pem');
    await exec(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    const credentials = { key: await readFile(keyPath), cert: await readFile(certPath) };
    const track = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); };
    let upstreamRequests = 0;
    const target = tls.createServer(credentials);
    target.on('tlsClientError', () => {}); servers.push(target); const targetPort = await listen(target);
    target.on('secureConnection', (socket) => { track(socket); let data = ''; socket.on('data', (chunk) => { data += chunk; if (data.includes('\r\n\r\n')) { upstreamRequests++; const body = '{"ip":"8.8.8.8"}'; socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } }); });
    const proxies = [];
    for (const protocol of ['http', 'https', 'socks4', 'socks5']) {
      const handler = (socket) => {
        track(socket); let buffer = Buffer.alloc(0); let phase = 0;
        function tunnel() {
          socket.removeListener('data', receive);
          const upstream = net.connect(targetPort, '127.0.0.1', () => { if (buffer.length) upstream.write(buffer); socket.pipe(upstream); upstream.pipe(socket); });
          track(upstream); socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
        }
        function receive(chunk) {
          buffer = Buffer.concat([buffer, chunk]);
          if (protocol === 'http' || protocol === 'https') {
            const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
            assert.match(buffer.subarray(0, end).toString(), /^CONNECT (localhost|127\.0\.0\.2):/);
            buffer = buffer.subarray(end + 4); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); tunnel();
          } else if (protocol === 'socks5') {
            if (phase === 0) { if (buffer.length < 3) return; assert.equal(buffer[0], 5); const size = 2 + buffer[1]; if (buffer.length < size) return; buffer = buffer.subarray(size); phase = 1; socket.write(Buffer.from([5, 0])); }
            if (phase === 1) { if (buffer.length < 5) return; assert.equal(buffer[3], 3); const size = 7 + buffer[4]; if (buffer.length < size) return; buffer = buffer.subarray(size); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); tunnel(); }
          } else {
            if (buffer.length < 9) return; const userEnd = buffer.indexOf(0, 8); if (userEnd < 0) return;
            const hostEnd = buffer.indexOf(0, userEnd + 1); if (hostEnd < 0) return;
            assert.equal(buffer[0], 4); buffer = buffer.subarray(hostEnd + 1); socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0])); tunnel();
          }
        }
        socket.on('data', receive);
      };
      const server = protocol === 'https' ? tls.createServer(credentials, handler) : net.createServer(handler);
      server.on('tlsClientError', () => {}); servers.push(server);
      proxies.push({ host: '127.0.0.1', port: await listen(server), protocol });
    }
    const stalled = net.createServer((socket) => track(socket)); servers.push(stalled);
    const stallPort = await listen(stalled); proxies.push({ host: '127.0.0.1', port: stallPort, protocol: 'http' });
    const started = Date.now();
    const data = JSON.parse(await invoke('network-fixture.php', { ca: certPath, target: `https://localhost:${targetPort}/ip`, proxies }));
    for (const proxy of proxies.slice(0, 4)) assert.equal(data.results[`${proxy.protocol}:${proxy.port}`].status, 'alive', JSON.stringify(data));
    const timeout = data.results[`http:${stallPort}`]; assert.equal(timeout.status, 'dead'); assert.ok(timeout.latencyMs >= 2900 && timeout.latencyMs < 4500, JSON.stringify(timeout));
    assert.ok(Date.now() - started < 6000); assert.equal(data.peak, 5); assert.equal(upstreamRequests, 4);
    const invalid = JSON.parse(await invoke('network-fixture.php', { ca: certPath, target: `https://127.0.0.2:${targetPort}/ip`, proxies: [proxies[0]] }));
    assert.equal(Object.values(invalid.results)[0].status, 'dead', 'A TLS hostname mismatch passed');
    target.removeAllListeners('secureConnection'); target.on('secureConnection', (socket) => { track(socket); socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')); });
    const badBody = JSON.parse(await invoke('network-fixture.php', { ca: certPath, target: `https://localhost:${targetPort}/ip`, proxies: [proxies[0]] }));
    assert.equal(Object.values(badBody.results)[0].status, 'dead', 'A non-IP response passed');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  }
});

test('PHP website works from a subdirectory: setup/login, CSRF, live exports, source controls, private storage and cron startup', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-php-http-'));
  const reservation = net.createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  const env = { PROXYFORGE_PHP_DATA: join(directory, 'data') };
  await invoke('seed-fixture.php', undefined, env);
  const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', dirname(root)], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
  let serverLog = ''; child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const base = `http://127.0.0.1:${port}/${root.split(/[\\/]/).at(-1)}/`;
  let cookie = ''; let token;
  async function request(path, options = {}) {
    const response = await fetch(base + path, { redirect: 'manual', ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  }
  const post = (action, body = {}, csrf = token) => request(`api.php?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Proxy-Forge-Token': csrf }, body: JSON.stringify(body) });
  try {
    await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error(serverLog || 'PHP did not listen')), 5000); const check = () => { if (serverLog.includes('Development Server')) { clearTimeout(deadline); resolve(); } else setTimeout(check, 20); }; check(); });
    let response = await request('api.php?action=state'); assert.equal(response.status, 401);
    response = await request('index.php'); const setup = await response.text(); assert.match(setup, /Tạo tài khoản quản trị/); token = setup.match(/name="csrf" value="([^"]+)"/)[1];
    response = await request('index.php', { method: 'POST', body: new URLSearchParams({ csrf: token, password: 'test-password-123', confirm: 'test-password-123' }) }); assert.equal(response.status, 303);
    response = await request('index.php'); assert.match(await response.text(), /assets\/app.js/);
    let state = await (await request('api.php?action=state')).json(); token = state.token; assert.equal(state.automation.enabled, true); assert.equal(state.counts.total, 1);
    assert.equal((await post('stop', {}, 'invalid-token')).status, 403);
    const unauthorized = await fetch(base + 'api.php?action=export'); assert.equal(unauthorized.status, 401);
    const rows = await (await request('api.php?action=export&format=json&status=all')).json(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'alive');
    assert.equal((await (await request('api.php?action=proxies&country=US')).json()).total, 0);
    assert.equal((await (await request('api.php?action=proxies&country=VN')).json()).rows[0].server, 'PHP Test ISP');
    const sources = await (await request('api.php?action=sources')).json(); assert.equal(sources.length, 50);
    assert.equal((await post('sources/toggle', { ids: [sources[0].id], enabled: true })).status, 200);
    assert.equal((await post('sources/toggle', { ids: [sources[0].id], enabled: false })).status, 200);
    assert.equal((await post('sources/add', { url: 'https://127.0.0.1/list', protocol: 'http' })).status, 400);
    assert.equal((await post('sources/add', { url: 'https://example.com/list', name: 'Fixture', protocol: 'socks5' })).status, 200);
    response = await request('cron.php?key=wrong'); assert.equal(response.status, 403);
    const info = await (await request('api.php?action=info')).json(); assert.match(info.cronCommand, /^\* \* \* \* \* php /);
    assert.equal((await request('worker.php')).status, 404);
    assert.equal((await request('storage/state.php')).status, 404);
    assert.equal((await request('tests/seed-fixture.php')).status, 404);
    // CLI cron starts the backend with no browser POST; disable sources to keep all external checks out of this test.
    await post('sources/toggle', { ids: (await (await request('api.php?action=sources')).json()).map((source) => source.id), enabled: false });
    await post('clear');
    const cron = await exec(php, [join(root, 'cron.php')], { env: { ...process.env, ...env } }); assert.equal(JSON.parse(cron.stdout).state, 'done');
    state = await (await request('api.php?action=state')).json(); assert.equal(state.automation.rounds, 1); assert.equal(state.counts.total, 0);
    assert.equal(state.job.options.concurrency, 10000); assert.equal(state.job.options.timeoutMs, 3000);
    const imported = await (await post('import', { text: '8.8.8.8:8080', protocol: 'http' })).json(); assert.equal(imported.added, 1); assert.equal(imported.counts.total, 0); assert.equal(imported.queued, 1);
    assert.equal((await post('clear')).status, 200);
    await post('stop'); state = await (await request('api.php?action=state')).json(); assert.equal(state.automation.enabled, false);
    await post('auto', { enabled: true }); assert.equal((await (await request('api.php?action=state')).json()).automation.enabled, true);
    await post('logout'); assert.equal((await request('api.php?action=state')).status, 401);
    response = await request('index.php'); const login = await response.text(); assert.doesNotMatch(login, /name="confirm"/); token = login.match(/name="csrf" value="([^"]+)"/)[1];
    response = await request('index.php', { method: 'POST', body: new URLSearchParams({ csrf: token, password: 'wrong-password' }) }); assert.equal(response.status, 400);
    response = await request('index.php', { method: 'POST', body: new URLSearchParams({ csrf: token, password: 'test-password-123' }) }); assert.equal(response.status, 303);
    assert.equal((await request('api.php?action=state')).status, 200);
  } finally {
    child.kill(); await new Promise((resolve) => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function exerciseUI() {
  const $ = (selector) => document.querySelector(selector);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const until = (condition) => new Promise((resolve, reject) => { if (condition()) return resolve(); const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('UI timed out')); }, 5000); const observer = new MutationObserver(() => { if (condition()) { clearTimeout(timeout); observer.disconnect(); resolve(); } }); observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true }); });
  try {
    await until(() => $('#proxyRows tr') && $('#country').options.length === 251);
    check($('#concurrency').value === '10000', 'Default concurrency changed'); check($('#resume').hidden, 'The UI asks for a start click'); check($('#proxyRows').textContent.includes('Test ISP'), 'Metadata is missing');
    for (const view of ['proxies', 'sources', 'setup', 'overview']) { $(`.nav-link[data-view="${view}"] span`).click(); await until(() => !$('#' + view).hidden); }
    $('#country').value = 'US'; $('#country').dispatchEvent(new Event('change', { bubbles: true })); await until(() => !$('#proxyRows tr'));
    $('#country').value = 'VN'; $('#country').dispatchEvent(new Event('change', { bubbles: true })); await until(() => $('#proxyRows tr'));
    for (const name of ['Import', 'Export', 'Source']) { $('#open' + name).click(); const id = name.toLowerCase() + 'Dialog'; check($('#' + id).open, id + ' did not open'); $(`[data-close="${id}"]`).click(); check(!$('#' + id).open, id + ' did not close'); }
    $('#stop').click(); await until(() => !$('#resume').hidden); $('#resume').click(); await until(() => $('#resume').hidden);
    document.body.insertAdjacentHTML('beforeend', '<pre id="php-ui-result">PASS: native PHP UI, relative URLs, 249 countries, metadata, dialogs, navigation, pause/resume</pre>');
  } catch (error) { document.body.insertAdjacentHTML('beforeend', '<pre id="php-ui-result">FAIL: ' + error.message + '</pre>'); }
}

test('PHP dashboard browser controls and relative API paths work without external scripts', { timeout: 30000 }, async (t) => {
  if (!browser) { t.skip('Set PROXYFORGE_BROWSER to run browser checks'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'pf-php-ui-')); const requests = []; let enabled = true;
  const markup = (await exec(php, ['-r', '$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["SCRIPT_NAME"]="/index.php"; require $argv[1];', join(root, 'index.php')], { env: { ...process.env, PROXYFORGE_PHP_DATA: join(directory, 'data') } })).stdout;
  // Render the authenticated PHP template using an isolated session, then serve native HTML/JS with controlled state.
  const html = await invoke('render-fixture.php', undefined, { PROXYFORGE_PHP_DATA: join(directory, 'data') });
  assert.match(markup, /Tạo tài khoản quản trị/);
  const rendered = html;
  const source = { id: 'fixture', name: 'Fixture', publisher: 'example.com', url: 'https://example.com/list', protocol: 'http', enabled: true };
  const status = () => ({ token: 'php-ui-token', counts: { total: 1, alive: 1 }, sources: { total: 1, enabled: 1, ok: 1 }, limits: { maxConcurrency: 10000 }, job: null, worker: { online: true }, automation: { enabled, nextRunAtMs: Date.now() + 60000, rounds: 1, options: { concurrency: 10000, limit: 100000 } } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; assert.equal(req.headers['x-proxy-forge-token'], 'php-ui-token'); const action = url.searchParams.get('action'); requests.push(action); if (action === 'stop') enabled = false; if (action === 'auto') enabled = true; res.end(JSON.stringify(status())); }
    else if (url.pathname === '/site/index.php') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(rendered.replace('</head>', '<script src="ui-test.js" defer></script></head>')); }
    else if (url.pathname === '/site/ui-test.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`(${exerciseUI.toString()})()`); }
    else if (url.pathname.startsWith('/site/assets/')) { const name = url.pathname.split('/').at(-1); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/css'); res.end(await readFile(join(root, 'assets', name))); }
    else if (url.pathname === '/site/api.php') { const action = url.searchParams.get('action'); if (action === 'state') res.end(JSON.stringify(status())); else if (action === 'sources') res.end(JSON.stringify([source])); else if (action === 'proxies') res.end(JSON.stringify({ rows: url.searchParams.get('country') === 'US' ? [] : [{ id: 'http://8.8.8.8:8080', host: '8.8.8.8', port: 8080, protocol: 'http', status: 'alive', countryCode: 'VN', server: 'Test ISP', asn: 7552, latencyMs: 42 }], total: 1, page: 1, pages: 1, pageSize: 50 })); else if (action === 'info') res.end(JSON.stringify({ cronCommand: '* * * * * php cron.php', workerCommand: 'php worker.php', cronToken: 'fixture' })); else res.end('{}'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  try {
    assert.match(rendered, /assets\/app.js/);
    const port = await listen(server);
    const { stdout } = await exec(browser, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(directory, 'browser')}`, '--dump-dom', '--virtual-time-budget=15000', `http://127.0.0.1:${port}/site/index.php`], { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    const result = stdout.match(/<pre id="php-ui-result">([^<]*)<\/pre>/)?.[1]; assert.match(result || 'Browser did not finish', /^PASS:/); assert.deepEqual(requests, ['stop', 'auto']); t.diagnostic(result);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
