(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const locale = new Intl.NumberFormat('vi-VN');
  const fmt = (value) => locale.format(Number(value) || 0);
  const pad = (value) => String(value).padStart(2, '0');
  const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['vi'], { type: 'region' }) : null;
  const countryName = (code) => code ? countryNames?.of(code) || code : 'Chưa xác định';
  const countryFilter = document.createElement('select');
  countryFilter.id = 'countryFilter'; countryFilter.setAttribute('aria-label', 'Lọc quốc gia');
  countryFilter.innerHTML = '<option value="all">Mọi quốc gia</option><option value="unknown">Chưa xác định</option>';
  $('#protocolFilter').after(countryFilter);
  const exportCountry = countryFilter.cloneNode(true);
  exportCountry.id = 'exportCountry'; exportCountry.setAttribute('aria-label', 'Quốc gia xuất');
  const exportCountryLabel = document.createElement('label'); exportCountryLabel.textContent = 'Quốc gia';
  exportCountryLabel.append(exportCountry); $('#exportForm .config-grid').append(exportCountryLabel);
  for (const title of ['SERVER / ASN', 'VỊ TRÍ ƯỚC TÍNH']) {
    const heading = document.createElement('th'); heading.textContent = title;
    $('th.table-action-col').before(heading);
  }
  const $state = { token: '', revision: -1, sources: [], sourceSignature: '', timer: null,
    proxyTimer: null, toastTimer: null, page: 1, pageSize: 50, status: 'all', protocol: 'all',
    search: '', country: 'all', sourceQuery: '', currentView: 'overview', events: null, lastRefresh: 0, busy: false };

  async function loadCountries() {
    const codes = await api('/countries.json');
    const options = codes.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    for (const select of [countryFilter, exportCountry]) {
      for (const { code, name } of options) select.add(new Option(`${name} (${code})`, code));
    }
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      headers.set('X-Proxy-Forge-Token', $state.token);
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(response.status === 404 && url.startsWith('/api/')
        ? 'Backend đang chạy bản cũ. Mở lại Run-Python.cmd để nạp backend mới.'
        : data.error || `Yêu cầu lỗi HTTP ${response.status}.`);
    }
    if (response.headers.get('content-type')?.includes('application/json')) return response.json();
    return response;
  }

  function toast(message, error = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast${error ? ' error' : ''}`;
    element.hidden = false;
    clearTimeout($state.toastTimer);
    $state.toastTimer = setTimeout(() => { element.hidden = true; }, error ? 5200 : 3200);
  }

  function clock(ms) {
    const seconds = Math.floor((Number(ms) || 0) / 1000);
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  }

  function setView(view) {
    $state.currentView = ['overview', 'proxies', 'sources', 'guide'].includes(view) ? view : 'overview';
    document.body.dataset.view = $state.currentView;
    $('#overviewView').hidden = $state.currentView !== 'overview';
    $('#proxiesView').hidden = !['overview', 'proxies'].includes($state.currentView);
    $('#sourcesView').hidden = $state.currentView !== 'sources';
    $('#guideView').hidden = $state.currentView !== 'guide';
    for (const link of $$('.nav-link')) link.classList.toggle('active', link.dataset.view === $state.currentView);
    const names = { overview: 'Tổng quan', proxies: 'Kho proxy', sources: 'Nguồn thu thập', guide: 'Hướng dẫn & API' };
    const titles = { overview: ['Mọi proxy. Một nơi.', 'Thu thập rộng. Kiểm tra thật. Chỉ giữ lại những kết nối tốt.'],
       proxies: ['Proxy live của bạn.', 'Chỉ hiện proxy đã qua HTTPS; tự cập nhật sau mỗi lần đo.'],
      sources: ['Đa dạng nguồn. Lọc trùng tự động.', 'Bật, tắt hoặc thêm feed HTTPS công khai.'],
      guide: ['Dùng dữ liệu đúng cách.', 'Hiểu trạng thái proxy, tốc độ kiểm tra và API cục bộ.'] };
    $('#breadcrumbCurrent').textContent = names[$state.currentView];
    $('#pageTitle').textContent = titles[$state.currentView][0];
    $('#pageDescription').textContent = titles[$state.currentView][1];
    if (location.hash.slice(1) !== $state.currentView) history.replaceState(null, '', `#${$state.currentView}`);
  }

  function makeChart(rate, busy) {
    const width = 340;
    const height = 96;
    const samples = makeChart.samples ||= Array(44).fill(0);
    samples.push(Math.max(0, Number(rate) || 0));
    samples.shift();
    const max = Math.max(10, ...samples) * 1.2;
    const coords = samples.map((value, index) => [index * width / (samples.length - 1),
      88 - (Math.max(0, value) / max) * 76]);
    const path = `M${coords.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}`;
    $('#chartLine').setAttribute('d', busy ? path : 'M0 92 L340 92');
    $('#chartArea').setAttribute('d', busy ? `${path} L340 110 L0 110 Z` : 'M0 92 L340 92 L340 110 L0 110 Z');
    $('#chartEmpty').hidden = busy || samples.some((sample) => sample > 0);
    $('#chartRate').textContent = `${fmt(rate)} proxy/s`;
  }

  function updateStatusFilters(counts) {
    $('#filterAllCount').textContent = fmt(counts.total);
    $('#filterAliveCount').textContent = fmt(counts.alive);
    const total = Number(counts.total) || 0;
    const current = $state.status === 'all' ? total : Number(counts[$state.status]) || 0;
    $('#tableTotal').textContent = fmt(current);
  }

  function renderState(data) {
    $state.token = data.token || $state.token;
    const counts = data.counts || {};
    const total = Number(counts.total) || 0;
    $('#statTotal').textContent = fmt(total);
    $('#statAlive').innerHTML = `${fmt(counts.alive)}<span class="stat-unit">LIVE</span>`;
    $('#statLatency').innerHTML = `${data.latencyMs == null ? '—' : fmt(data.latencyMs)}<span class="stat-unit">ms</span>`;
    $('#capacityFill').style.width = `${Math.min(100, total / (data.limits?.maxProxies || 100000) * 100)}%`;
    const source = data.sources || {};
    $('#statSources').textContent = fmt(source.total || 0);
    $('#navProxyCount').textContent = total > 999 ? `${Math.floor(total / 1000)}k` : fmt(total);
    $('#navSourceCount').textContent = fmt(source.total || 0);
    $('#publisherDescription').textContent = `${fmt(source.publishers || 0)} nhà cung cấp · ${fmt(source.domains || 0)} domain`;
    $('#aliveDescription').textContent = counts.alive ? 'Đã qua yêu cầu HTTPS thật' : 'Đang chờ proxy qua kiểm tra HTTPS';
    updateStatusFilters(counts);

    const job = data.job;
    const auto = data.automation || {};
    const outdated = !data.automation;
    $state.busy = Boolean(job?.state === 'running');
    $('#stopButton').hidden = !$state.busy && !auto.enabled;
    $('#collectButton').hidden = outdated || Boolean(auto.enabled);
    $('#collectButton').disabled = outdated || $state.busy || Boolean(auto.enabled);
    $('#emptyCollectButton').hidden = outdated || Boolean(auto.enabled);
    $('#emptyCollectButton').disabled = outdated || $state.busy || Boolean(auto.enabled);
    $('#checkButton').disabled = outdated || $state.busy;
    for (const id of ['collectLimit', 'checkConcurrency']) $(`#${id}`).disabled = $state.busy || Boolean(auto.enabled);
    if (auto.enabled && auto.options) {
      $('#collectLimit').value = String(auto.options.limit);
      $('#checkConcurrency').value = String(auto.options.concurrency);
    }
    const next = auto.nextRunAtMs == null ? null : Math.max(0, Math.ceil((auto.nextRunAtMs - Date.now()) / 1000));
    $('#autoStatus').textContent = outdated ? 'Backend đang chạy bản cũ · Mở lại Run-Python.cmd để tự nạp bản mới'
      : auto.error ? `Tự động: ${auto.error}` : auto.enabled
      ? $state.busy ? 'Backend tự chạy mỗi 60 giây · Đang cập nhật proxy live'
        : `Backend tự chạy mỗi 60 giây · Lượt tiếp theo sau ${next ?? 0} giây · ${fmt(auto.rounds)} lượt hoàn tất`
      : 'Đã tạm dừng trong phiên này · Backend sẽ tự chạy khi mở lại';
    $('#monitorVisual').classList.toggle('is-running', $state.busy);
    $('#monitorState').innerHTML = $state.busy
      ? '<span class="dot"></span>ĐANG CHẠY' : `<span class="dot"></span>${auto.enabled ? 'CHỜ LƯỢT TIẾP' : job?.state === 'stopped' ? 'ĐÃ DỪNG' : job?.state === 'error' ? 'CÓ LỖI' : 'SẴN SÀNG'}`;
    const completed = Number(job?.completed) || 0;
    const jobTotal = Number(job?.total) || 0;
    const percent = jobTotal ? Math.min(100, completed / jobTotal * 100) : 0;
    $('#jobPercent').textContent = `${Math.floor(percent)}%`;
    $('#jobProgress').style.width = `${percent}%`;
    $('#jobCompleted').innerHTML = `${fmt(completed)} <small>/ ${fmt(jobTotal)}</small>`;
    $('#jobElapsed').textContent = job ? clock(job.elapsedMs) : '00:00';
    $('#jobEta').textContent = job?.etaSeconds == null ? '—' : clock(job.etaSeconds * 1000);
    const labels = { collect: 'Tải nguồn mới', check: 'Kiểm tra HTTPS', refresh: 'Cập nhật proxy live' };
    $('#jobLabel').textContent = job ? `${$state.busy ? job.phase === 'location' ? 'Bổ sung vị trí / ASN' : labels[job.phase] || labels[job.type] : labels[job.type] || 'Tác vụ'}${$state.busy ? ' đang chạy' : job.state === 'done' ? ' hoàn tất' : job.state === 'stopped' ? ' đã dừng' : ''}` : 'Chưa có tác vụ';
    $('#monitorDot').style.background = $state.busy ? 'var(--lime)' : job?.state === 'error' ? 'var(--red)' : '';
    $('#jobDetail').textContent = !job ? 'Tự tải nguồn, đo HTTPS rồi xuất proxy live.' : job.error ? job.error : job.type === 'refresh'
      ? `${fmt(job.added || 0)} ứng viên mới · ${fmt(job.networkChecked || 0)} đã đo · ${fmt(job.liveAdded || 0)} live mới · ${fmt(job.removed || 0)} live cũ bị loại`
      : `${fmt(job.networkChecked || 0)} đo mạng · ${fmt(job.removed || 0)} proxy chết đã xóa${job.geoWarning ? ' · Chưa có dữ liệu ASN/vị trí' : ''}`;
    makeChart(job?.rate || 0, $state.busy);

    const connection = $('#connectionState');
    connection.classList.remove('offline');
    connection.innerHTML = '<span class="dot"></span>Local · đang chạy';
    if (data.warning) toast(data.warning, true);
    const signature = JSON.stringify(data.sources);
    if (signature !== $state.sourceSignature) {
      $state.sourceSignature = signature;
      refreshSources().catch(() => {});
    }
    const now = performance.now();
    if (now - $state.lastRefresh > 900 || !$state.busy) {
      $state.lastRefresh = now;
      refreshProxies().catch(() => {});
    }
  }

  async function refreshState() {
    try {
      const state = await api('/api/state');
      renderState(state);
      if (!$state.events) {
        $state.events = new EventSource('/api/events');
        $state.events.onmessage = (message) => {
          try { renderState(JSON.parse(message.data)); } catch { /* Ignore malformed progress event. */ }
        };
        $state.events.onerror = () => {
          const connection = $('#connectionState');
          connection.classList.add('offline');
          connection.innerHTML = '<span class="dot"></span>Đang kết nối lại';
        };
      }
    } catch (error) {
      const connection = $('#connectionState');
      connection.classList.add('offline');
      connection.innerHTML = '<span class="dot"></span>Python engine ngoại tuyến';
      if (!$state.timer) toast(`${error.message} Hãy chạy Run-Python.cmd.`, true);
    }
  }

  async function refreshProxies() {
    const params = new URLSearchParams({ status: $state.status, protocol: $state.protocol,
      country: $state.country, search: $state.search, page: String($state.page), pageSize: String($state.pageSize) });
    const result = await api(`/api/proxies?${params}`);
    const tbody = $('#proxyRows');
    const empty = result.rows.length === 0;
    $('#emptyState').hidden = !empty;
    tbody.innerHTML = result.rows.map((proxy, index) => {
      const stateLabels = { alive: 'HTTPS sống', handshake: 'Bắt tay', checking: 'Đang kiểm tra',
        pending: 'Chờ kiểm tra', dead: 'Không kết nối' };
      const address = `${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;
      const latency = proxy.latencyMs == null ? '—' : `${fmt(proxy.latencyMs)} ms`;
      const latencyClass = proxy.latencyMs > 1200 ? 'slow' : '';
      const sources = (proxy.sources || []).filter((source) => source !== 'manual');
      const provenance = sources.length ? sources[0].split('-')[0] + (sources.length > 1 ? ` +${sources.length - 1}` : '') : 'nhập tay';
      return `<tr><td>${String((result.page - 1) * result.pageSize + index + 1).padStart(2, '0')}</td><td><span class="proxy-address">${escapeHTML(address)}</span></td><td><span class="protocol-tag ${escapeHTML(proxy.protocol)}">${escapeHTML(proxy.protocol.toUpperCase())}</span></td><td><span class="status-label status-${escapeHTML(proxy.status)}"><span class="dot"></span>${escapeHTML(stateLabels[proxy.status] || proxy.status)}</span></td><td>${proxy.latencyMs == null ? '<span class="latency-value">—</span>' : `<span class="latency-bar ${latencyClass}"><i></i><i></i><i></i></span><span class="latency-value">${latency}</span>`}</td><td><span class="source-pill">${escapeHTML(proxy.exitIP || '—')}</span></td><td><span class="source-pill">${escapeHTML(provenance)}</span></td><td><button class="copy-button" data-copy="${escapeHTML(proxy.id)}" title="Sao chép proxy" aria-label="Sao chép ${escapeHTML(address)}">${icon('copy')}</button></td></tr>`;
    }).join('');
    [...tbody.rows].forEach((row, index) => {
      const proxy = result.rows[index];
      const server = row.insertCell(row.cells.length - 1);
      server.textContent = [proxy.server, proxy.asn ? `AS${proxy.asn}` : ''].filter(Boolean).join(' · ') || 'Chưa xác định';
      server.className = 'proxy-server'; server.title = server.textContent;
      const place = row.insertCell(row.cells.length - 1);
      place.textContent = [proxy.countryCode ? countryName(proxy.countryCode) : proxy.country, proxy.city].filter(Boolean).join(' · ') || 'Chưa xác định';
      place.title = `Vị trí ước tính của IP máy chủ · ${proxy.locationSource || 'chưa có dữ liệu'}`;
    });
    $('#paginationSummary').textContent = result.total
      ? `Hiển thị ${fmt((result.page - 1) * result.pageSize + 1)}–${fmt(Math.min(result.page * result.pageSize, result.total))} / ${fmt(result.total)} proxy`
      : 'Hiển thị 0 proxy';
    $('#pageIndicator').textContent = `${result.page} / ${result.pages}`;
    $('#previousPage').disabled = result.page <= 1;
    $('#nextPage').disabled = result.page >= result.pages;
    if ($state.page > result.pages) { $state.page = result.pages; return refreshProxies(); }
  }

  async function refreshSources() {
    $state.sources = await api('/api/sources');
    const query = $state.sourceQuery.toLowerCase();
    const visible = $state.sources.filter((source) => !query || `${source.name} ${source.publisher} ${source.url}`.toLowerCase().includes(query));
    $('#sourcesTotal').textContent = `${fmt($state.sources.length)} website`;
    $('#sourceExplanation').textContent = `${fmt($state.sources.length)} website/API từ ${fmt(new Set($state.sources.map((source) => source.publisher)).size)} nhà cung cấp. Nguồn có thể tạm lỗi hoặc giới hạn truy cập.`;
    $('#sourceEnabledCount').textContent = `${fmt($state.sources.filter((source) => source.enabled).length)} đang bật`;
    $('#sourceList').innerHTML = visible.map((source) => {
      const sourceStatus = { idle: 'Chưa tải', ok: `${fmt(source.count || 0)} proxy`, error: source.error || 'Lỗi tải', fetching: 'Đang tải…' };
      const protocols = source.protocols || [...new Set((source.feeds || [source]).map((feed) => feed.protocol))];
      return `<label class="source-item"><input type="checkbox" data-source-id="${escapeHTML(source.id)}" ${source.enabled ? 'checked' : ''} aria-label="Bật ${escapeHTML(source.name)}"><span class="source-details"><span class="source-name">${escapeHTML(source.name)}${protocols.map((protocol) => `<span class="protocol-tag ${escapeHTML(protocol)}">${escapeHTML(protocol.toUpperCase())}</span>`).join('')}${source.custom ? '<span class="micro-badge">CUSTOM</span>' : ''}</span><a class="source-url" href="${escapeHTML(source.url)}" target="_blank" rel="noreferrer noopener" title="${escapeHTML(source.url)}">${escapeHTML(source.url)}</a></span><span class="source-state ${escapeHTML(source.status || 'idle')}">${escapeHTML(sourceStatus[source.status] || 'Chưa tải')}${source.feedErrors?.length ? `<small>${fmt(source.feedErrors.length)} endpoint lỗi</small>` : ''}${source.durationMs ? `<small>${fmt(source.durationMs)} ms</small>` : ''}</span></label>`;
    }).join('') || '<div class="empty-state"><h3>Không tìm thấy nguồn</h3><p>Thử từ khóa khác.</p></div>';
  }

  async function post(path, data = {}) {
    const result = await api(path, { method: 'POST', body: data });
    renderState({ ...result, token: $state.token });
    return result;
  }

  function openDialog(id) {
    const dialog = $(`#${id}`);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeDialog(id) { const dialog = $(`#${id}`); if (dialog?.open) dialog.close(); }

  document.addEventListener('click', async (event) => {
    // body[data-view] describes the layout; only navigation links change views.
    const nav = event.target.closest('.nav-link[data-view]');
    if (nav) { event.preventDefault(); setView(nav.dataset.view); refreshProxies().catch(() => {}); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    const button = event.target.closest('button');
    try {
      if (action === 'import') openDialog('importDialog');
      if (action === 'export') { exportCountry.value = $state.country; openDialog('exportDialog'); }
      const close = event.target.closest('[data-close]')?.dataset.close;
      if (close) closeDialog(close);
      if (button?.matches('[data-status]')) {
        $state.status = button.dataset.status; $state.page = 1;
        for (const filterButton of $$('[data-status]')) filterButton.classList.toggle('active', filterButton === button);
        await refreshProxies();
      }
      const copy = event.target.closest('[data-copy]');
      if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); toast('Đã sao chép địa chỉ proxy.'); }
      if (button === $('#refreshButton')) { await refreshProxies(); toast('Đã làm mới danh sách.'); }
      if (button === $('#previousPage')) { $state.page = Math.max(1, $state.page - 1); await refreshProxies(); }
      if (button === $('#nextPage')) { $state.page++; await refreshProxies(); }
      if (button === $('#emptyCollectButton') || button === $('#collectButton')) await post('/api/auto', {
        enabled: true, limit: Number($('#collectLimit').value), concurrency: Number($('#checkConcurrency').value) });
      if (button === $('#checkButton')) await post('/api/refresh', {
        limit: Number($('#collectLimit').value), concurrency: Number($('#checkConcurrency').value) });
      if (button === $('#stopButton')) await post('/api/stop');
      if (button === $('#addSourceButton')) openDialog('sourceDialog');
      if (button === $('#enableAllSources') || button === $('#disableAllSources')) {
        await post('/api/sources/toggle', { ids: $state.sources.map((source) => source.id), enabled: button === $('#enableAllSources') });
        $state.sourceSignature = ''; await refreshState();
      }
      if (button === $('#clearButton')) openDialog('clearDialog');
      if (button === $('#confirmClearButton')) {
        await post('/api/clear'); closeDialog('clearDialog'); toast('Đã xóa kho proxy trên thiết bị này.');
      }
    } catch (error) { toast(error.message, true); }
  });

  document.addEventListener('change', async (event) => {
    try {
      if (event.target === $('#protocolFilter')) { $state.protocol = event.target.value; $state.page = 1; await refreshProxies(); }
      if (event.target === countryFilter) { $state.country = event.target.value; $state.page = 1; await refreshProxies(); }
      if (event.target === $('#pageSize')) { $state.pageSize = Number(event.target.value); $state.page = 1; await refreshProxies(); }
      if (event.target.matches('[data-source-id]')) {
        await post('/api/sources/toggle', { ids: [event.target.dataset.sourceId], enabled: event.target.checked });
        $state.sourceSignature = ''; await refreshSources();
      }
      if (event.target === $('#importFile') && event.target.files?.[0]) {
        const file = event.target.files[0];
        if (file.size > 8 * 1024 * 1024) throw new Error('Tệp nhập tối đa 8 MB.');
        $('#importText').value = await file.text();
      }
    } catch (error) { toast(error.message, true); }
  });

  $('#proxySearch').addEventListener('input', (event) => {
    clearTimeout($state.proxyTimer); $state.search = event.target.value; $state.page = 1;
    $state.proxyTimer = setTimeout(() => refreshProxies().catch((error) => toast(error.message, true)), 180);
  });
  $('#sourceSearch').addEventListener('input', (event) => {
    $state.sourceQuery = event.target.value; refreshSources().catch(() => {});
  });

  $('#importForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await post('/api/import', { text: $('#importText').value, protocol: $('#importProtocol').value });
      closeDialog('importDialog');
      toast(`Đã nhận ${fmt(result.added)} proxy mới · đang kiểm tra HTTPS trước khi hiện kết quả.`);
      $('#importText').value = ''; $('#importFile').value = '';
    } catch (error) { toast(error.message, true); }
  });

  $('#exportForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const params = new URLSearchParams({ format: $('#exportFormat').value, status: $('#exportStatus').value,
      protocol: $('#exportProtocol').value, country: exportCountry.value, bare: $('#exportBare').checked ? '1' : '0' });
    const link = document.createElement('a'); link.href = `/api/export?${params}`;
    document.body.append(link); link.click(); link.remove(); closeDialog('exportDialog');
    toast('Đang chuẩn bị tệp tải xuống.');
  });

  $('#sourceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await post('/api/sources/add', { name: $('#newSourceName').value.trim(), url: $('#newSourceURL').value.trim(), protocol: $('#newSourceProtocol').value });
      closeDialog('sourceDialog'); $('#newSourceName').value = ''; $('#newSourceURL').value = '';
      $state.sourceSignature = ''; await refreshState(); toast('Đã thêm feed HTTPS công khai.');
    } catch (error) { toast(error.message, true); }
  });

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
  }
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
  setView(location.hash.slice(1));
  loadCountries().catch((error) => toast(`Không tải được bộ lọc quốc gia: ${error.message}`, true));
  refreshSources().catch(() => {});
  refreshState();
  $state.timer = setInterval(refreshState, 3200);
})();
