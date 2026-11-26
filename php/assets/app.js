(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const fmt = (value) => new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['vi'], { type: 'region' }) : null;
  const countryName = (code) => code ? countryNames?.of(code) || code : 'Chưa xác định';
  const state = { token: '', page: 1, pages: 1, sources: [], busy: false, loading: false, sourceSignature: '', timer: null, configured: false };

  function toast(message, error = false) {
    $('#toast').textContent = message;
    $('#toast').className = `toast${error ? ' error' : ''}`;
    $('#toast').hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { $('#toast').hidden = true; }, error ? 6500 : 3800);
  }

  async function api(action, body, query = {}) {
    const params = new URLSearchParams({ action, ...query });
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', 'X-Proxy-Forge-Token': state.token };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`api.php?${params}`, options);
    const result = await response.json();
    if (response.status === 401) { location.assign('index.php'); throw new Error('Phiên đã hết hạn.'); }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }

  const filters = () => ({ country: $('#country').value, protocol: $('#protocol').value, search: $('#search').value, page: state.page, pageSize: 50 });
  async function proxies() {
    const result = await api('proxies', undefined, filters());
    state.page = result.page; state.pages = result.pages;
    $('#proxyRows').innerHTML = result.rows.map((row, index) => `<tr><td>${(result.page - 1) * result.pageSize + index + 1}</td><td>${escape(`${row.host.includes(':') ? `[${row.host}]` : row.host}:${row.port}`)}</td><td><span class="protocol-tag ${escape(row.protocol)}">${escape(row.protocol.toUpperCase())}</span></td><td>${fmt(row.latencyMs)} ms</td><td>${escape(row.exitIP || '—')}</td><td title="${escape(row.server)}">${escape([row.server, row.asn ? `AS${row.asn}` : ''].filter(Boolean).join(' · ') || 'Chưa xác định')}</td><td title="${escape(row.locationSource || 'Vị trí từ nguồn')}">${escape([row.countryCode ? countryName(row.countryCode) : row.country, row.city].filter(Boolean).join(' · ') || 'Chưa xác định')}</td><td><button class="small" data-copy="${escape(row.id)}" aria-label="Sao chép ${escape(row.id)}">⧉</button></td></tr>`).join('');
    $('#empty').hidden = result.rows.length > 0;
    $('#tableCount').textContent = fmt(result.total);
    $('#paginationSummary').textContent = result.total ? `${fmt((result.page - 1) * result.pageSize + 1)}–${fmt(Math.min(result.page * result.pageSize, result.total))} / ${fmt(result.total)} proxy` : '0 proxy';
    $('#page').textContent = `${result.page} / ${result.pages}`;
    $('#previous').disabled = result.page <= 1; $('#next').disabled = result.page >= result.pages;
  }

  async function sources() {
    state.sources = await api('sources');
    $('#sourceList').innerHTML = state.sources.map((source) => `<label class="source-item"><input type="checkbox" data-source="${escape(source.id)}" ${source.enabled ? 'checked' : ''} ${state.busy ? 'disabled' : ''}><span><span class="source-name">${escape(source.name)}</span><a class="source-url" href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.url)}</a></span><span class="source-status ${escape(source.status || '')}" title="${escape(source.error || '')}">${escape(source.status === 'ok' ? `${fmt(source.count)} proxy · ${fmt(source.durationMs)} ms` : source.status === 'error' ? source.error : 'Chưa tải')}</span></label>`).join('');
  }

  function render(data) {
    state.token = data.token || state.token;
    const auto = data.automation; const job = data.job; const worker = data.worker;
    state.busy = job?.state === 'running' && worker.online;
    $('#statTotal').textContent = fmt(data.counts.total); $('#statAlive').textContent = fmt(data.counts.alive);
    $('#statSources').textContent = fmt(data.sources.total); $('#navLive').textContent = fmt(data.counts.alive); $('#navSources').textContent = fmt(data.sources.total);
    $('#statLatency').textContent = data.latencyMs == null ? '—' : fmt(data.latencyMs);
    $('#sourceSummary').textContent = `${fmt(data.sources.enabled)} đang bật · ${fmt(data.sources.ok)} tải thành công`;
    $('#resume').hidden = auto.enabled; $('#stop').hidden = !auto.enabled && !state.busy;
    $('#refresh').disabled = state.busy || data.refreshRequested; $('#clear').disabled = state.busy;
    for (const id of ['limit', 'concurrency']) $(`#${id}`).disabled = auto.enabled || state.busy;
    for (const option of $('#concurrency').options) option.disabled = Number(option.value) > data.limits.maxConcurrency;
    if (![...$('#concurrency').options].some((option) => Number(option.value) === auto.options.concurrency)) $('#concurrency').add(new Option(fmt(auto.options.concurrency), String(auto.options.concurrency)));
    if (auto.enabled || state.busy || !state.configured) {
      $('#concurrency').value = String(auto.options.concurrency); $('#limit').value = String(auto.options.limit);
      state.configured = true;
    }
    const next = auto.nextRunAtMs == null ? null : Math.max(0, Math.ceil((auto.nextRunAtMs - Date.now()) / 1000));
    $('#autoStatus').textContent = auto.error ? `Lượt gần nhất: ${auto.error}` : !auto.enabled ? 'Đã tạm dừng · Tiếp tục để chạy lại theo lịch backend' : state.busy ? 'Backend tự chạy mỗi 60 giây · Đang cập nhật HTTPS live' : data.refreshRequested ? 'Đã xếp lịch cập nhật · Cron/worker sẽ nhận yêu cầu' : `Backend tự chạy mỗi 60 giây · ${fmt(auto.rounds)} lượt hoàn tất${next == null ? '' : ` · lượt tiếp theo sau ${next} giây`}`;
    $('#connection').classList.toggle('offline', !worker.online);
    $('#connection').innerHTML = `<span class="dot"></span>${worker.online ? 'PHP backend · đang hoạt động' : 'PHP web · chờ cron/worker'}`;
    $('#workerNotice').hidden = worker.online;
    $('#workerNotice').innerHTML = 'Chưa có tín hiệu cron/worker trong 130 giây. <a href="#setup">Mở cài đặt hosting</a> để thêm Cron Job mỗi phút; backend sẽ tự chạy khi đóng tab.';
    const total = job?.total || 0; const percent = total ? Math.min(100, (job.completed || 0) / total * 100) : 0;
    $('#jobCompleted').textContent = `${fmt(job?.completed)} / ${fmt(total)}`; $('#jobPercent').textContent = `${Math.floor(percent)}%`; $('#jobProgress').value = percent;
    const phase = { collect: 'TẢI NGUỒN', check: 'KIỂM TRA HTTPS', location: 'BỔ SUNG ASN / QUỐC GIA' };
    $('#jobStatus').textContent = state.busy ? phase[job.phase] || 'ĐANG CHẠY' : job?.state === 'done' ? 'HOÀN TẤT' : job?.state === 'error' ? 'CÓ LỖI' : job?.state === 'stopped' ? 'ĐÃ DỪNG' : 'CHỜ CRON';
    $('#jobDetail').textContent = job?.error || (job ? `${fmt(job.added)} ứng viên · ${fmt(job.networkChecked)} đã đo · ${fmt(job.liveAdded)} live mới · ${fmt(job.removed)} live cũ bị loại${job.geoWarning ? ' · Chưa đủ dữ liệu địa lý' : ''}` : 'Cron/worker khởi động là tự tải và kiểm tra.');
    const elapsed = Math.floor((job?.elapsedMs || 0) / 1000); $('#jobElapsed').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    const signature = JSON.stringify(data.sources) + state.busy;
    if (signature !== state.sourceSignature) { state.sourceSignature = signature; sources().catch(() => {}); }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try { render(await api('state')); await proxies(); }
    catch (error) { $('#connection').classList.add('offline'); $('#connection').textContent = 'Mất kết nối'; toast(error.message, true); }
    finally { state.loading = false; }
  }
  async function post(action, body = {}) { const result = await api(action, body); if (result.automation) render(result); return result; }

  async function info() {
    const data = await api('info');
    $('#cronCommand').textContent = data.cronCommand; $('#workerCommand').textContent = data.workerCommand;
    const url = new URL('cron.php', location.href); url.hash = ''; url.search = new URLSearchParams({ key: data.cronToken });
    $('#cronURL').textContent = url.href; $('#runtime').textContent = `PHP ${data.php} · cURL ${data.curl} · memory_limit ${data.memoryLimit}`;
  }
  function view() {
    const selected = ['overview', 'proxies', 'sources', 'setup'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== selected && !(selected === 'overview' && section.id === 'proxies');
    $('#stats').hidden = !['overview', 'proxies'].includes(selected);
    for (const nav of document.querySelectorAll('.nav-link')) nav.classList.toggle('active', nav.dataset.view === selected);
    const titles = { overview: ['TỔNG QUAN', 'Mọi proxy. Một nơi.', 'Thu thập rộng. Kiểm tra thật. Chỉ giữ những kết nối tốt.'], proxies: ['KHO PROXY', 'Proxy live của bạn.', 'Đầu ra đã qua HTTPS, tự cập nhật sau mỗi lần đo.'], sources: ['NGUỒN THU THẬP', 'Đa dạng nguồn. Tự lọc trùng.', 'Tải mới từ các website/API công khai trong mỗi lượt.'], setup: ['CÀI ĐẶT HOSTING', 'Tự chạy từ backend.', 'Thiết lập cron một lần. Đóng tab, dữ liệu vẫn được cập nhật.'] };
    [$('#breadcrumb').textContent, $('#pageTitle').textContent, $('#pageDescription').textContent] = titles[selected];
    if (selected === 'setup') info().catch((error) => toast(error.message, true));
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.close) $(`#${button.dataset.close}`).close();
      if (button.dataset.copy) { await navigator.clipboard.writeText(button.dataset.copy); toast('Đã sao chép proxy.'); }
      const dialogs = { openImport: 'importDialog', openExport: 'exportDialog', openSource: 'sourceDialog', clear: 'clearDialog' };
      if (dialogs[button.id]) { if (button.id === 'openExport') $('#exportCountry').value = $('#country').value; $(`#${dialogs[button.id]}`).showModal(); }
      if (button.id === 'logout') { await post('logout'); location.assign('index.php'); }
      if (button.id === 'reload') await refresh();
      if (button.id === 'previous' || button.id === 'next') { state.page += button.id === 'next' ? 1 : -1; await proxies(); }
      if (button.id === 'resume') await post('auto', { enabled: true, concurrency: Number($('#concurrency').value), limit: Number($('#limit').value) });
      if (button.id === 'stop') await post('stop');
      if (button.id === 'refresh') { await post('refresh'); toast('Đã xếp lịch. Cron/worker sẽ nhận yêu cầu.'); }
      if (button.id === 'enableSources' || button.id === 'disableSources') { await post('sources/toggle', { ids: state.sources.map((source) => source.id), enabled: button.id === 'enableSources' }); await sources(); }
      if (button.id === 'confirmClear') { await post('clear'); $('#clearDialog').close(); await proxies(); toast('Đã xóa kho.'); }
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('change', async (event) => {
    try {
      if (['country', 'protocol'].includes(event.target.id)) { state.page = 1; await proxies(); }
      if (event.target.dataset.source) { await post('sources/toggle', { ids: [event.target.dataset.source], enabled: event.target.checked }); await sources(); }
      if (event.target.id === 'importFile' && event.target.files[0]) { if (event.target.files[0].size > 8 * 1024 * 1024) throw new Error('Tệp tối đa 8 MB.'); $('#importText').value = await event.target.files[0].text(); }
    } catch (error) { toast(error.message, true); }
  });
  $('#search').addEventListener('input', () => { clearTimeout(state.timer); state.timer = setTimeout(() => { state.page = 1; proxies().catch((error) => toast(error.message, true)); }, 220); });
  $('#importForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await post('import', { text: $('#importText').value, protocol: $('#importProtocol').value }); $('#importDialog').close(); $('#importText').value = ''; $('#importFile').value = ''; toast(`Đã xếp ${fmt(result.added)} proxy mới vào hàng đợi HTTPS.`); } catch (error) { toast(error.message, true); } });
  $('#sourceForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await post('sources/add', { name: $('#sourceName').value, url: $('#sourceURL').value, protocol: $('#sourceProtocol').value }); $('#sourceDialog').close(); $('#sourceForm').reset(); await sources(); } catch (error) { toast(error.message, true); } });
  $('#exportForm').addEventListener('submit', (event) => { event.preventDefault(); const params = new URLSearchParams({ action: 'export', format: $('#exportFormat').value, country: $('#exportCountry').value, protocol: $('#protocol').value, bare: $('#exportBare').checked ? '1' : '0' }); const link = document.createElement('a'); link.href = `api.php?${params}`; document.body.append(link); link.click(); link.remove(); $('#exportDialog').close(); });
  async function countries() { const response = await fetch('assets/countries.json'); const codes = await response.json(); const options = codes.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'vi')); for (const select of [$('#country'), $('#exportCountry')]) for (const { code, name } of options) select.add(new Option(`${name} (${code})`, code)); }
  window.addEventListener('hashchange', view); view();
  countries().catch((error) => toast(error.message, true)); refresh(); setInterval(refresh, 3000);
})();
