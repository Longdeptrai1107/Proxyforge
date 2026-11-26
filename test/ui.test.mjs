import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const browser = [process.env.PROXYFORGE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path) => path && existsSync(path));

// Run the real HTML and app.js in Chromium. In particular, synthetic DOM stubs
// would miss closest() reaching body[data-view] and canceling native actions.
async function exerciseUI() {
  const $ = (selector) => document.querySelector(selector);
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = (condition) => new Promise((resolve, reject) => {
    if (condition()) { resolve(); return; }
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('UI update timed out')); }, 3000);
    const observer = new MutationObserver(() => {
      if (condition()) { clearTimeout(timer); observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const results = [];
  try {
    await until(() => $('#connectionState').textContent.includes('đang chạy'));
    expect($('#checkConcurrency').value === '10000', 'Default concurrency must be 10,000');
    expect($('#checkTimeout').value === '3000' && $('#checkTimeout').disabled, 'Timeout must be fixed at 3 seconds');
    expect($('#checkMode').value === 'https' && $('#checkMode').disabled, 'Live output must use HTTPS verification');
    expect($('#exportStatus').options.length === 1 && $('#exportStatus').value === 'alive', 'Exports must offer live only');
    results.push('10,000 concurrent probes, 3-second timeout and live-only exports');
    for (const view of ['proxies', 'sources', 'guide', 'overview']) {
      $(`.nav-link[data-view="${view}"] svg use`).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(document.body.dataset.view === view, `Navigation to ${view} failed`);
      expect(!$('#' + view + 'View').hidden, `${view} view is hidden`);
    }
    results.push('navigation including nested SVG');

    expect(!$('#stopButton').hidden, 'Backend automation was not shown on first connection');
    expect($('#collectButton').hidden && $('#emptyCollectButton').hidden, 'Startup must not ask for a start click');
    $('#stopButton').click();
    await until(() => $('#stopButton').hidden);
    $('#emptyCollectButton').click();
    await until(() => !$('#stopButton').hidden);
    $('#stopButton').click();
    await until(() => $('#stopButton').hidden);
    results.push('backend auto on first connection, pause and resume');

    $('[data-action="import"] svg use').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect($('#importDialog').open, 'Import button did not open its dialog');
    $('#importText').value = '8.8.8.8:8080';
    $('#importForm button[type="submit"]').click();
    await until(() => !$('#importDialog').open);
    await until(() => $('#proxyRows tr'));
    expect($('#statTotal').textContent === '1', 'Import did not update counts');
    results.push('import dialog and native form submission');

    for (const id of ['import', 'export']) {
      $(`[data-action="${id}"]`).click();
      expect($('#' + id + 'Dialog').open, `${id} dialog did not open`);
      $(`[data-close="${id}Dialog"] svg use`).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(!$('#' + id + 'Dialog').open, `${id} dialog did not close`);
    }
    results.push('dialog open and close buttons');

    await until(() => $('#countryFilter').options.length >= 251);
    expect($('#countryFilter').options.length === 251, 'Country filter does not contain 249 countries plus all/unknown');
    expect($('#proxyRows').textContent.includes('Test ISP'), 'Server metadata is missing');
    $('#countryFilter').value = 'US'; $('#countryFilter').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => !$('#proxyRows tr'));
    $('#countryFilter').value = 'VN'; $('#countryFilter').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => $('#proxyRows tr'));
    $('[data-status="alive"]').click();
    await until(() => $('[data-status="alive"]').classList.contains('active'));
    $('#refreshButton').click();
    await until(() => $('#toast').textContent === 'Đã làm mới danh sách.');
    results.push('249 countries, server metadata, country/status filters and refresh');

    $('.nav-link[data-view="sources"]').click();
    await until(() => $('[data-source-id]'));
    $('[data-source-id]').click();
    await until(() => $('#sourceEnabledCount').textContent.startsWith('0 '));
    $('[data-source-id]').click();
    await until(() => $('#sourceEnabledCount').textContent.startsWith('1 '));
    $('#addSourceButton').click();
    expect($('#sourceDialog').open, 'Add-source button did not open its dialog');
    $('#newSourceURL').value = 'https://example.com/new';
    $('#sourceForm button[type="submit"]').click();
    await until(() => !$('#sourceDialog').open);
    $('#disableAllSources').click();
    await until(() => $('#sourceEnabledCount').textContent.startsWith('0 '));
    $('#enableAllSources').click();
    await until(() => $('#sourceEnabledCount').textContent.startsWith('1 '));
    results.push('source form and enable/disable actions');

    $('.nav-link[data-view="overview"]').click();
    for (const id of ['collectButton', 'checkButton']) {
      $('#' + id).click();
      await until(() => !$('#stopButton').hidden);
      expect($('#collectButton').disabled && $('#checkButton').disabled, 'Running job did not lock job buttons');
      $('#stopButton').click();
      await until(() => $('#stopButton').hidden);
    }
    results.push('auto start, immediate refresh and stop');

    $('#clearButton').click();
    expect($('#clearDialog').open, 'Clear button did not open confirmation');
    $('#confirmClearButton').click();
    await until(() => !$('#clearDialog').open);
    await until(() => $('#statTotal').textContent === '0');
    results.push('clear confirmation and action');
    document.body.insertAdjacentHTML('beforeend', '<pre id="ui-test-result">PASS: ' + results.join('; ') + '</pre>');
  } catch (error) {
    document.body.insertAdjacentHTML('beforeend', '<pre id="ui-test-result">FAIL: ' + error.message + '</pre>');
  }
}

test('browser controls dispatch actions without body layout intercepting clicks', { timeout: 30000 }, async (t) => {
  if (!browser) { t.skip('Set PROXYFORGE_BROWSER to a Chromium executable to run UI regression tests.'); return; }
  const profile = await mkdtemp(join(tmpdir(), 'proxyforge-ui-'));
  const requests = [];
  const source = { id: 'fixture', name: 'Fixture', publisher: 'example.com', url: 'https://example.com/list', protocol: 'http', enabled: true };
  let total = 0;
  let job = { type: 'refresh', phase: 'collect', state: 'running', total: 1 };
  let enabled = true;
  const state = () => ({ token: 'ui-test-token', counts: { total, pending: 0, alive: total }, job,
    automation: { enabled, intervalMs: 60000, nextRunAtMs: Date.now() + 60000, rounds: 0,
      options: { limit: 100000, concurrency: 10000, timeoutMs: 3000 } }, liveOnly: true,
    sources: { total: 1, enabled: Number(source.enabled), publishers: 1, domains: 1 } });
  const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
    .replace('</head>', '<script src="/ui-test.js" defer></script></head>');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.headers['x-proxy-forge-token'], 'ui-test-token');
      requests.push({ path: url.pathname, body: JSON.parse(body) });
      if (url.pathname === '/api/import') total = 1;
      if (url.pathname === '/api/clear') total = 0;
      if (url.pathname === '/api/sources/toggle') source.enabled = JSON.parse(body).enabled;
      if (['/api/auto', '/api/refresh'].includes(url.pathname)) job = { type: 'refresh', phase: 'collect', state: 'running', total: 1 };
      if (url.pathname === '/api/auto') enabled = true;
      if (url.pathname === '/api/stop') { job.state = 'stopped'; enabled = false; }
      res.end(JSON.stringify({ added: 1, duplicates: 0, ...state() }));
    } else if (url.pathname === '/api/state') res.end(JSON.stringify(state()));
    else if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(': fixture\n\n'); }
    else if (url.pathname === '/api/sources') res.end(JSON.stringify([source]));
    else if (url.pathname === '/api/proxies') res.end(JSON.stringify({ rows: total && url.searchParams.get('country') !== 'US' ? [{ id: 'http://8.8.8.8:8080', host: '8.8.8.8', port: 8080, protocol: 'http', status: 'alive', sources: [], countryCode: 'VN', server: 'Test ISP', asn: 64500, city: 'Hanoi' }] : [], page: 1, pages: 1, total, pageSize: 50 }));
    else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else if (url.pathname === '/ui-test.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`(${exerciseUI.toString()})()`); }
    else if (['/app.js', '/styles.css', '/favicon.svg', '/countries.json'].includes(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.json') ? 'application/json' : url.pathname.endsWith('.css') ? 'text/css' : 'image/svg+xml');
      res.end(await readFile(new URL('../public' + url.pathname, import.meta.url)));
    } else { res.writeHead(404); res.end('{}'); }
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { stdout } = await promisify(execFile)(browser, ['--headless', '--disable-gpu', '--no-first-run',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=10000',
      `http://127.0.0.1:${server.address().port}`], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    const result = stdout.match(/<pre id="ui-test-result">([^<]*)<\/pre>/)?.[1];
    assert.match(result || 'Browser did not finish UI checks', /^PASS:/);
    assert.deepEqual(requests.map(({ path }) => path), ['/api/stop', '/api/auto', '/api/stop', '/api/import', '/api/sources/toggle', '/api/sources/toggle', '/api/sources/add',
      '/api/sources/toggle', '/api/sources/toggle', '/api/auto', '/api/stop',
      '/api/refresh', '/api/stop', '/api/clear']);
    assert.equal(requests.find(({ path }) => path === '/api/auto').body.concurrency, 10000);
    assert.equal(requests.find(({ path }) => path === '/api/auto').body.enabled, true);
    assert.equal(requests.find(({ path }) => path === '/api/refresh').body.concurrency, 10000);
    t.diagnostic(result);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
