'use strict';

/* ============ 状态 ============ */
const LS = { config: 'bd_config', accounts: 'bd_accounts', settings: 'bd_settings' };
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
// 同源部署（Lambda Function URL 直接打开本页）时默认用同源地址，无需配置
const sameOriginBase = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : '';

let state = {
  config: loadJSON(LS.config, { apiBaseUrl: '', apiKey: '' }),
  accounts: loadJSON(LS.accounts, []),
  settings: loadJSON(LS.settings, { timeMode: '1h', customStart: '', customEnd: '', autoRefresh: true, modelFilter: '', selectedAccount: 'all' }),
};

let lastResults = [];          // [{ account, data | error }]
let charts = {};               // chart instances
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = 0;
let lastUpdateText = '';
let editingId = null;

/* ============ 工具 ============ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function maskKey(k) { return (!k || k.length <= 4) ? (k || '') : '••••' + k.slice(-4); }
function fmtNum(n) { return (n == null || isNaN(n)) ? '0' : Number(n).toLocaleString(); }
function round(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function fmtMoney(v, c) {
  if (v == null) return '-';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (c || 'USD');
}
function fmtLocal(iso) { return iso ? new Date(iso).toLocaleString() : '-'; }
function tzLabel() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const off = -new Date().getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const m = String(Math.abs(off) % 60).padStart(2, '0');
  return `${tz} (UTC${s}${h}:${m})`;
}

let toastTimer = null;
function toast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, 3600);
}

/* ============ 时间范围 ============ */
// 相对预设（最近 N 分钟/小时/本月/上月）与自定义绝对时间（datetime-local，本地时区）
function computeWindow() {
  const mode = state.settings.timeMode || '1h';
  const now = new Date();
  if (mode === 'custom') {
    const s = state.settings.customStart ? new Date(state.settings.customStart) : null;
    const e = state.settings.customEnd ? new Date(state.settings.customEnd) : null;
    if (!s || !e || isNaN(s) || isNaN(e) || s >= e) return null;
    return { start: s, end: e, minutes: Math.round((e - s) / 60000) };
  }
  if (mode === 'thisMonth') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  if (mode === 'lastMonth') return {
    start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
  };
  const mins = ({ '1h': 60, '6h': 360, '24h': 1440 })[mode] || 60;
  return { start: new Date(now.getTime() - mins * 60000), end: now, minutes: mins };
}

function timeRangeLabel() {
  const mode = state.settings.timeMode || '1h';
  const sel = document.getElementById('timeRangeSelect');
  return sel && mode !== 'custom' ? (sel.options[sel.selectedIndex] || {}).text || mode :
    (mode === 'custom' ? '自定义范围' : mode);
}

function onTimeModeChange() {
  const mode = document.getElementById('timeRangeSelect').value;
  state.settings.timeMode = mode;
  saveJSON(LS.settings, state.settings);
  const custom = document.getElementById('customRange');
  if (mode === 'custom') {
    // 预填：上次的自定义值，或默认最近 24 小时（本地时区，适配 datetime-local）
    const toLocal = d => {
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const rs = document.getElementById('rangeStart'), re = document.getElementById('rangeEnd');
    rs.value = state.settings.customStart || toLocal(new Date(Date.now() - 24 * 3600 * 1000));
    re.value = state.settings.customEnd || toLocal(new Date());
    custom.classList.remove('hidden');
  } else {
    custom.classList.add('hidden');
    refresh();
  }
}

function applyCustomRange() {
  const rs = document.getElementById('rangeStart').value;
  const re = document.getElementById('rangeEnd').value;
  if (!rs || !re) { toast('请填写开始和结束时间', 'error'); return; }
  if (new Date(rs) >= new Date(re)) { toast('开始时间必须早于结束时间', 'error'); return; }
  state.settings.customStart = rs;
  state.settings.customEnd = re;
  saveJSON(LS.settings, state.settings);
  refresh();
}

/* ============ 账户列表 / 筛选 ============ */
function persistAccounts() {
  // 只持久化非临时账户（未勾选"保存到本机浏览器"的账户仅本次会话有效）
  saveJSON(LS.accounts, state.accounts.filter(a => !a.transient));
}

function renderAccounts() {
  const wrap = document.getElementById('accountsList');
  wrap.innerHTML = '';
  state.accounts.forEach(acc => {
    const chip = document.createElement('div');
    chip.className = 'account-chip';
    chip.innerHTML = `<span class="dot"></span><span class="name">${escapeHtml(acc.label)}</span>` +
      (acc.transient ? '<span class="tag" title="仅本次会话有效，不会写入本机">临时</span>' : '') +
      `<span class="key">${maskKey(acc.accessKeyId)}</span>`;
    const edit = document.createElement('button');
    edit.textContent = '编辑'; edit.className = 'mini';
    edit.onclick = () => openAccountModal(acc.id);
    const del = document.createElement('button');
    del.textContent = '×'; del.className = 'mini danger';
    del.onclick = () => {
      if (confirm('删除账户 “' + acc.label + '”？')) {
        state.accounts = state.accounts.filter(a => a.id !== acc.id);
        persistAccounts();
        if (state.settings.selectedAccount === acc.id) state.settings.selectedAccount = 'all';
        renderAccounts(); renderFilter(); renderDashboard();
      }
    };
    chip.appendChild(edit); chip.appendChild(del);
    wrap.appendChild(chip);
  });
  renderFilter();
}

function clearStoredCreds() {
  if (!state.accounts.length) { toast('当前没有已保存的账户', 'info'); return; }
  const saved = state.accounts.filter(a => !a.transient).length;
  if (!confirm('删除本机浏览器已保存的全部 ' + saved + ' 个账户密钥（localStorage）？\n该操作不影响 AWS 侧的任何资源。')) return;
  localStorage.removeItem(LS.accounts);
  state.config.apiKey = '';
  saveJSON(LS.config, state.config);
  state.accounts = [];
  state.settings.selectedAccount = 'all';
  lastResults = [];
  renderAccounts(); renderDashboard();
  toast('本机已保存的密钥已全部删除', 'success');
}

function renderFilter() {
  const sel = document.getElementById('accountFilter');
  const cur = state.settings.selectedAccount;
  sel.innerHTML = '<option value="all">全部账户</option>';
  state.accounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = a.label; sel.appendChild(o);
  });
  sel.value = state.accounts.some(a => a.id === cur) ? cur : 'all';
  state.settings.selectedAccount = sel.value;
}

/* ============ 账户弹窗 ============ */
function openAccountModal(id) {
  editingId = id || null;
  const acc = id ? state.accounts.find(a => a.id === id) : null;
  document.getElementById('accountModalTitle').textContent = id ? '编辑账户' : '添加账户';
  document.getElementById('accKeyId').value = acc ? acc.accessKeyId : '';
  document.getElementById('accSecret').value = acc ? acc.secretAccessKey : '';
  document.getElementById('accToken').value = acc ? acc.sessionToken : '';
  document.getElementById('accRegions').value = acc ? (acc.regions || []).join(',') : 'us-east-1';
  document.getElementById('accPersist').checked = acc ? !acc.transient : true;
  document.getElementById('accountModal').classList.remove('hidden');
}
function closeAccountModal() { document.getElementById('accountModal').classList.add('hidden'); }
function saveAccount() {
  // 账户名称无需手填：先用密钥尾号占位，首次查询后由 STS GetCallerIdentity
  // 读出的真实 Account ID 自动替换。
  const accessKeyId = document.getElementById('accKeyId').value.trim();
  const secretAccessKey = document.getElementById('accSecret').value.trim();
  const sessionToken = document.getElementById('accToken').value.trim();
  const regions = document.getElementById('accRegions').value.split(',').map(s => s.trim()).filter(Boolean);
  const persist = document.getElementById('accPersist').checked;
  if (!accessKeyId || !secretAccessKey) { toast('请填写 Access Key 和 Secret', 'error'); return; }
  if (!regions.length) regions.push('us-east-1');
  const label = 'Account ' + maskKey(accessKeyId);
  if (editingId) {
    Object.assign(state.accounts.find(x => x.id === editingId), { label, accessKeyId, secretAccessKey, sessionToken, regions, transient: !persist });
  } else {
    state.accounts.push({ id: 'a_' + Date.now(), label, accessKeyId, secretAccessKey, sessionToken, regions, transient: !persist });
  }
  persistAccounts();
  closeAccountModal(); renderAccounts(); toast(persist ? '已保存到本机浏览器（账户名将自动读取）' : '已添加（仅本次会话，关闭页面即清除）', 'success');
  refresh();
}

/* ============ 设置弹窗 ============ */
function openSettings() {
  document.getElementById('setApiUrl').value = state.config.apiBaseUrl || '';
  document.getElementById('setApiKey').value = state.config.apiKey || '';
  document.getElementById('setModelFilter').value = state.settings.modelFilter || '';
  document.getElementById('setAutoRefresh').checked = state.settings.autoRefresh;
  document.getElementById('settingsModal').classList.remove('hidden');
}
function saveSettings() {
  state.config.apiBaseUrl = document.getElementById('setApiUrl').value.trim().replace(/\/+$/, '');
  state.config.apiKey = document.getElementById('setApiKey').value.trim();
  state.settings.modelFilter = document.getElementById('setModelFilter').value.trim();
  state.settings.autoRefresh = document.getElementById('setAutoRefresh').checked;
  saveJSON(LS.config, state.config);
  saveJSON(LS.settings, state.settings);
  document.getElementById('settingsModal').classList.add('hidden');
  startRefreshCycle();
  refresh();
  toast('设置已保存', 'success');
}

/* ============ 查询 ============ */
async function queryAccount(acc) {
  // apiBaseUrl is the full endpoint: for Lambda Function URL it is the root URL;
  // for API Gateway it is ".../prod/query". POST directly, no path appended.
  // Falls back to same-origin when the page itself is served by the Lambda.
  const url = (state.config.apiBaseUrl || sameOriginBase).replace(/\/+$/, '');
  const w = computeWindow();
  if (!w) { toast('自定义时间范围无效：请检查开始/结束时间', 'error'); return { account: acc, error: 'invalid time range' }; }
  const body = {
    accountLabel: acc.label,
    credentials: { accessKeyId: acc.accessKeyId, secretAccessKey: acc.secretAccessKey, sessionToken: acc.sessionToken },
    regions: acc.regions,
    startTime: w.start.toISOString(),
    endTime: w.end.toISOString(),
    windowMinutes: w.minutes || 60,
    modelFilter: state.settings.modelFilter
      ? state.settings.modelFilter.split(',').map(s => s.trim()).filter(Boolean) : null,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (state.config.apiKey) headers['x-api-key'] = state.config.apiKey;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    return { account: acc, data };
  } catch (e) {
    return { account: acc, error: String(e) };
  }
}

async function refresh() {
  document.getElementById('refreshInfo').textContent = '刷新中…';
  if (!state.config.apiBaseUrl && !sameOriginBase) { toast('请先在「设置」中填写 API 地址', 'error'); document.getElementById('refreshInfo').textContent = ''; return; }
  if (!state.accounts.length) { toast('请先添加至少一个账户', 'error'); document.getElementById('refreshInfo').textContent = ''; return; }
  const results = await Promise.all(state.accounts.map(queryAccount));
  lastResults = results;
  // 账户名自动读取：用 STS GetCallerIdentity 返回的 Account ID 替换占位名
  let renamed = false;
  results.forEach(r => {
    const id = r.data && r.data.caller && r.data.caller.accountId;
    if (id) {
      r.account.accountId = id;
      if (r.account.label !== id) { r.account.label = id; renamed = true; }
    }
  });
  if (renamed) { persistAccounts(); renderAccounts(); }
  renderDashboard();
  lastUpdateText = '最近更新：' + new Date().toLocaleTimeString();
  scheduleNext();
  updateRefreshInfo();
}

/* ============ 聚合 ============ */
function aggregate() {
  const fid = state.settings.selectedAccount;
  const results = fid === 'all' ? lastResults : lastResults.filter(r => r.account.id === fid);
  const models = {};
  let totalCost = 0, costCurrency = 'USD';
  const costByAccount = [];
  results.forEach(r => {
    if (r.error || !r.data || !r.data.success) return;
    const d = r.data;
    (d.models || []).forEach(m => {
      const t = models[m.modelId] || (models[m.modelId] = { modelId: m.modelId, input: 0, output: 0, invocations: 0, latList: [] });
      t.input += m.inputTokens || 0;
      t.output += m.outputTokens || 0;
      t.invocations += m.invocations || 0;
      if (m.avgLatencyMs != null) t.latList.push(m.avgLatencyMs);
    });
    if (d.cost) {
      totalCost += d.cost.amount || 0;
      if (d.cost.currency) costCurrency = d.cost.currency;
      costByAccount.push({ label: r.account.label, amount: d.cost.amount || 0, currency: d.cost.currency || 'USD', services: d.cost.services });
    }
  });
  Object.values(models).forEach(t => { t.avgLatency = t.latList.length ? t.latList.reduce((a, b) => a + b, 0) / t.latList.length : 0; });
  return { models: Object.values(models), totalCost, costCurrency, costByAccount };
}

/* ============ 渲染 ============ */
function renderDashboard() {
  const agg = aggregate();
  renderSummary(agg);
  renderCharts(agg);
  renderHealth();
  renderQuotas();
  renderDetail();
  const w = lastResults.map(r => r.data && r.data.window).find(Boolean);
  document.getElementById('windowLabel').textContent = w ? `${timeRangeLabel()}：${fmtLocal(w.start)} ~ ${fmtLocal(w.end)}` : '';
}

function renderSummary(agg) {
  const totalTok = agg.models.reduce((s, m) => s + m.input + m.output, 0);
  const totalInv = agg.models.reduce((s, m) => s + m.invocations, 0);
  // 成本分项（悬停可见）：各 Bedrock 相关服务（含 Claude Bedrock Edition 订阅）的费用构成
  const costTitle = agg.costByAccount.flatMap(c => (c.services || [])
    .map(s => `${c.label} · ${s.name}: ${fmtMoney(s.amount, c.currency)}`)).join('\n');
  const cards = [
    { t: '总成本（本窗口）', v: fmtMoney(agg.totalCost, agg.costCurrency), title: costTitle },
    { t: '总 Token 数', v: fmtNum(totalTok) },
    { t: '总调用次数', v: fmtNum(totalInv) },
    { t: '活跃模型数', v: fmtNum(agg.models.length) },
  ];
  document.getElementById('summaryCards').innerHTML = cards.map(c =>
    `<div class="card summary"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><div class="s-title">${c.t}</div><div class="s-value">${c.v}</div></div>`).join('');
}

function paletteColors(n) {
  const base = ['#36a2eb', '#ff6384', '#2dd4bf', '#ff9f40', '#9966ff', '#ffcd56', '#8ac926', '#1982c4', '#6a4c93', '#f15bb5'];
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function drawBar(id, labels, datasets, options) {
  destroyChart(id);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels, datasets },
    options: Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } }, options || {}),
  });
}
function drawDoughnut(id, labels, data) {
  destroyChart(id);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: paletteColors(labels.length) }] },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function renderCharts(agg) {
  const models = agg.models.slice().sort((a, b) => (b.input + b.output) - (a.input + a.output));
  const labels = models.map(m => m.modelId);
  drawBar('tokenChart', labels, [
    { label: '输入 Token', data: models.map(m => m.input), backgroundColor: '#36a2eb' },
    { label: '输出 Token', data: models.map(m => m.output), backgroundColor: '#ff6384' },
  ], { scales: { x: { stacked: true }, y: { stacked: true } } });
  // 调用次数 / 平均延迟：每个模型自动分配一种颜色（paletteColors 支持数组式 backgroundColor）
  drawBar('invocationChart', labels, [{ label: '调用次数', data: models.map(m => m.invocations), backgroundColor: paletteColors(models.length) }]);
  drawBar('latencyChart', labels, [{ label: '平均延迟(ms)', data: models.map(m => round(m.avgLatency)), backgroundColor: paletteColors(models.length) }]);
  drawDoughnut('costChart', agg.costByAccount.map(c => c.label), agg.costByAccount.map(c => round(c.amount)));
}

/* ============ 账户健康探测 ============ */
function renderHealth() {
  const fid = state.settings.selectedAccount;
  const results = fid === 'all' ? lastResults : lastResults.filter(r => r.account.id === fid);
  let html = '<table class="detail"><thead><tr><th>账户</th><th>Account ID（STS）</th><th>身份 ARN</th><th>CloudShell 探测</th></tr></thead><tbody>';
  let rows = 0;
  results.forEach(r => {
    if (r.error || !r.data || !r.data.success) {
      html += `<tr><td>${escapeHtml(r.account.label)}</td><td colspan="3"><span class="err" title="${escapeHtml(r.error || (r.data && r.data.error) || '')}">查询失败</span></td></tr>`;
      rows++;
      return;
    }
    const c = r.data.caller || {};
    const cs = (r.data.health && r.data.health.cloudshell) || {};
    const idCell = c.accountId
      ? escapeHtml(c.accountId)
      : `<span class="err" title="${escapeHtml(c.error || '')}">读取失败</span>`;
    let csCell;
    if (cs.status === 'ok') {
      csCell = `<span style="color:#2dd4bf;">✓ 可用（${cs.environments} 个环境）</span>`;
    } else {
      const msg = cs.message || '未知错误';
      if (/verif|验证/i.test(msg)) {
        csCell = `<span class="err" title="${escapeHtml(msg)}">⚠️ 账户验证中（疑似被风控）</span>`;
      } else if (/not authorized|AccessDenied|权限/i.test(msg)) {
        csCell = `<span style="color:#93a3bd;cursor:help;" title="${escapeHtml(msg)}">🔒 密钥无 CloudShell 权限（不影响健康判断）</span>`;
      } else {
        csCell = `<span class="err" title="${escapeHtml(msg)}">✗ ${escapeHtml(msg.slice(0, 60))}</span>`;
      }
    }
    html += `<tr><td>${escapeHtml(r.account.label)}</td><td>${idCell}</td><td style="color:var(--muted);font-size:12px;">${escapeHtml(c.arn || '-')}</td><td>${csCell}</td></tr>`;
    rows++;
  });
  if (!rows) html += '<tr><td colspan="4">暂无数据（添加账户并刷新后显示）</td></tr>';
  html += '</tbody></table>';
  document.getElementById('healthTable').innerHTML = html;
}

/* ============ 服务配额 ============ */
function renderQuotas() {
  const fid = state.settings.selectedAccount;
  const results = fid === 'all' ? lastResults : lastResults.filter(r => r.account.id === fid);
  let html = '<table class="detail"><thead><tr><th>账户</th><th>区域</th><th>配额名称</th><th>配额码</th><th>当前值</th><th>单位</th></tr></thead><tbody>';
  let rows = 0;
  const codes = new Set();
  results.forEach(r => {
    const qs = (r.data && r.data.quotas) || [];
    qs.forEach(q => {
      codes.add(q.quotaCode);
      const val = q.error
        ? '<span class="err" title="' + escapeHtml(q.error) + '">查询失败</span>'
        : fmtNum(q.value);
      html += `<tr><td>${escapeHtml(r.account.label)}</td><td>${escapeHtml(q.region || '-')}</td>` +
        `<td>${escapeHtml(q.quotaName || '-')}</td><td>${escapeHtml(q.quotaCode || '-')}</td>` +
        `<td>${val}</td><td>${escapeHtml(q.unit || '-')}</td></tr>`;
      rows++;
    });
  });
  if (!rows) {
    html += '<tr><td colspan="6">暂无配额数据（需上传密钥具备 servicequotas:GetServiceQuota 权限）</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('quotaCodeLabel').textContent = [...codes].join(' / ') || 'L-D06938E7';
  document.getElementById('quotaTable').innerHTML = html;
}

function renderDetail() {
  const fid = state.settings.selectedAccount;
  const results = fid === 'all' ? lastResults : lastResults.filter(r => r.account.id === fid);
  let html = '<table class="detail"><thead><tr><th>账户</th><th>状态</th><th>模型</th><th>输入</th><th>输出</th><th>调用</th><th>延迟(ms)</th><th>成本</th></tr></thead><tbody>';
  const row = (a, b, c, d, e, f, g, h) =>
    `<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td><td>${escapeHtml(c)}</td><td>${d}</td><td>${e}</td><td>${f}</td><td>${g}</td><td>${h}</td></tr>`;
  results.forEach(r => {
    if (r.error) { html += row(r.account.label, '错误: ' + r.error, '-', '-', '-', '-', '-', '-'); return; }
    const d = r.data;
    if (!d || !d.success) { html += row(r.account.label, '失败: ' + escapeHtml((d && d.error) || '未知'), '-', '-', '-', '-', '-', '-'); return; }
    const ms = d.models || [];
    if (!ms.length) {
      const cost = d.cost ? fmtMoney(d.cost.amount, d.cost.currency) : '-';
      html += row(r.account.label, 'OK（无指标数据）', '-', '-', '-', '-', '-', cost);
      return;
    }
    ms.forEach((m, i) => {
      const costCell = i === 0 ? fmtMoney(d.cost && d.cost.amount, d.cost && d.cost.currency) : '';
      html += row(
        i === 0 ? r.account.label : '', i === 0 ? 'OK' : '', m.modelId,
        fmtNum(m.inputTokens), fmtNum(m.outputTokens), fmtNum(m.invocations), round(m.avgLatencyMs), costCell
      );
    });
  });
  html += '</tbody></table>';
  document.getElementById('detailTable').innerHTML = html;
}

/* ============ 自动刷新 ============ */
function scheduleNext() {
  nextRefreshAt = state.settings.autoRefresh ? Date.now() + 15 * 60 * 1000 : 0;
}
function updateRefreshInfo() {
  if (state.settings.autoRefresh && nextRefreshAt) {
    const left = Math.max(0, nextRefreshAt - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    document.getElementById('refreshInfo').textContent = `${lastUpdateText} · 下次刷新 ${mm}分${String(ss).padStart(2, '0')}秒`;
  } else {
    document.getElementById('refreshInfo').textContent = lastUpdateText + ' · 自动刷新关闭';
  }
}
function startRefreshCycle() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  if (!state.settings.autoRefresh) { updateRefreshInfo(); return; }
  refreshTimer = setInterval(refresh, 15 * 60 * 1000);
  countdownTimer = setInterval(updateRefreshInfo, 1000);
}

/* ============ 初始化 ============ */
async function init() {
  document.getElementById('tzLabel').textContent = tzLabel();
  renderAccounts();

  // 同源部署（页面由 Lambda Function URL 直接提供）时默认用当前站点作 API 地址
  if (!state.config.apiBaseUrl && sameOriginBase) {
    state.config.apiBaseUrl = sameOriginBase;
    saveJSON(LS.config, state.config);
  }

  // 自动加载部署生成的 config.json（S3 静态站部署时含 API 地址与 Key；同源部署时不存在，忽略即可）
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.apiBaseUrl && !state.config.apiBaseUrl) state.config.apiBaseUrl = cfg.apiBaseUrl;
      if (cfg.apiKey && !state.config.apiKey) state.config.apiKey = cfg.apiKey;
      saveJSON(LS.config, state.config);
    }
  } catch (e) { /* 同源部署或本地 file:// 打开时忽略 */ }

  document.getElementById('addAccountBtn').onclick = () => openAccountModal(null);
  document.getElementById('clearCredsBtn').onclick = clearStoredCreds;
  // 时间范围选择器（顶栏）
  const trs = document.getElementById('timeRangeSelect');
  trs.value = state.settings.timeMode && [...trs.options].some(o => o.value === state.settings.timeMode)
    ? state.settings.timeMode : '1h';
  state.settings.timeMode = trs.value;
  trs.onchange = onTimeModeChange;
  document.getElementById('applyRangeBtn').onclick = applyCustomRange;
  if (state.settings.timeMode === 'custom') {
    document.getElementById('rangeStart').value = state.settings.customStart || '';
    document.getElementById('rangeEnd').value = state.settings.customEnd || '';
    document.getElementById('customRange').classList.remove('hidden');
  }
  document.getElementById('accCancel').onclick = closeAccountModal;
  document.getElementById('accSave').onclick = saveAccount;
  document.getElementById('settingsBtn').onclick = openSettings;
  document.getElementById('setCancel').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
  document.getElementById('setSave').onclick = saveSettings;
  document.getElementById('refreshBtn').onclick = refresh;
  document.getElementById('accountFilter').onchange = (e) => {
    state.settings.selectedAccount = e.target.value; saveJSON(LS.settings, state.settings); renderDashboard();
  };
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', ev => { if (ev.target === m) m.classList.add('hidden'); }));

  startRefreshCycle();
  if (state.config.apiBaseUrl && state.accounts.length) refresh();
  else toast('请先在「设置」填写 API 地址，并添加至少一个账户', 'info');
}

init();
