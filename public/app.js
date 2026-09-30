'use strict';

// iOS Safari ignores user-scalable=no, so pinch zoom is blocked here too.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

const state = {
  view: 'dashboard',
  config: null,
  settings: null,
  coins: [],
  coinsUpdatedAt: null,
  portfolio: null,
  status: null,
  verdict: null,
  accuracy: null,
  paper: null,
  prices: {},
  movers: [],
  moversError: null,
  seenNotifications: null,
  coinSymbol: null,
  planProfile: null,
  chartTf: null,
  chartCandles: [],
  chartStructure: null,
  chartHighlight: null,
  stageFilter: 'all',
  search: '',
  backtestMonths: 1,
  lastSegments: {}
};

const STAGE_LABEL = { blocked: 'Not in play', watching: 'Watching', 'setting-up': 'Setting up', ready: 'Ready to buy', holding: 'Holding' };
const STAGE_ORDER = { ready: 0, 'setting-up': 1, holding: 2, watching: 3, blocked: 4 };
const TF_MS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const TF_LABEL = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const TF_WORD = { '5m': '5-minute', '15m': '15-minute', '1h': '1-hour', '4h': '4-hour', '1d': 'daily' };
const RING_CIRCUMFERENCE = 119.4;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const fmtIdr = (n) => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
const fmtIdrShort = (n) => {
  const v = Math.abs(n || 0);
  const sign = n < 0 ? '-' : '';
  if (v >= 1e9) return `${sign}Rp ${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}Rp ${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${sign}Rp ${Math.round(v / 1e3)}k`;
  return `${sign}Rp ${Math.round(v)}`;
};
const fmtPct = (n, digits = 2) => `${n >= 0 ? '+' : ''}${Number(n ?? 0).toFixed(digits)}%`;
function fmtPrice(n) {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: abs >= 1000 ? 2 : 0 });
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function base(symbol) { return symbol.replace(/USDT$/, ''); }
function fmtCountdown(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}
function fmtAgo(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function fmtClock(ms) {
  const tz = state.config?.timeZone;
  const far = Math.abs(ms - Date.now()) > 6 * 86_400_000;
  const opts = far ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz } : { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz };
  try { return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms)); }
  catch { return new Date(ms).toLocaleString(); }
}

// --- API (admin token for state-changing calls) --------------------------------
const ADMIN_TOKEN_KEY = 'sally-admin-token';
function readAdminToken() { try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; } }
function saveAdminToken(token) { try { token ? localStorage.setItem(ADMIN_TOKEN_KEY, token) : localStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* storage blocked */ } }

async function api(path, opts, { retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = readAdminToken();
  if (opts?.method && opts.method !== 'GET' && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, opts && { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && !retried) {
    const entered = window.prompt('Admin token required for this action:');
    if (entered) {
      saveAdminToken(entered.trim());
      renderAdminTokenState();
      return api(path, opts, { retried: true });
    }
  }
  if (res.status === 401) { saveAdminToken(''); renderAdminTokenState(); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}

// --- small animation helpers ---------------------------------------------------
function animateNumber(el, target, format) {
  const from = Number(el.dataset.value);
  el.dataset.value = String(target);
  if (!Number.isFinite(from) || reducedMotion.matches || from === target) { el.textContent = format(target); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 700);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function flash(el, direction) {
  if (!el || reducedMotion.matches) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(direction > 0 ? 'flash-up' : 'flash-down');
}

function toast(title, message) {
  const host = $('toastHost');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${escapeHtml(title)}</b>${escapeHtml(message || '')}`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 6000);
}

// --- navigation ----------------------------------------------------------------
const VIEW_TITLE = { dashboard: 'Dashboard', radar: 'Radar', settings: 'Settings' };
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  $(`view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.nav-tab').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $('pageTitle').textContent = name === 'coin' ? base(state.coinSymbol || '') : VIEW_TITLE[name];
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  renderCurrentView();
}
document.querySelectorAll('.nav-tab').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.goto)));
$('backButton').addEventListener('click', () => showView('radar'));

function openCoin(symbol) {
  if (symbol !== state.coinSymbol) { state.chartTf = null; state.planProfile = null; state.chartHighlight = null; }
  state.coinSymbol = symbol;
  showView('coin');
  loadChart().catch(console.error);
}

// --- data ----------------------------------------------------------------------
function coinBySymbol(symbol) { return state.coins.find((c) => c.symbol === symbol) || null; }
function livePrice(coin) {
  return state.prices[coin.symbol]?.price ?? coin.prediction?.headline?.trigger?.livePrice ?? coin.prediction?.headline?.livePrice ?? coin.latest?.close;
}
function liveChange(coin) { return state.prices[coin.symbol]?.changePct ?? coin.latest?.changePct ?? 0; }
function headline(coin) { return coin?.prediction?.headline || null; }
const PROFILE_SHORT = { swing: 'Swing', trend: 'Trend', scalping: 'Scalp' };
function shortProfile(h) { return h?.profile ? `${PROFILE_SHORT[h.profile] || h.profile} · ${TF_LABEL[h.timeframe] || ''}` : ''; }
function stageOf(coin) { return headline(coin)?.stage || 'blocked'; }

async function loadCore() {
  const [coins, portfolio, status] = await Promise.allSettled([api('/api/coins'), api('/api/portfolio'), api('/api/engine/status')]);
  if (coins.status === 'fulfilled') { state.coins = coins.value.coins || []; state.coinsUpdatedAt = coins.value.updatedAt; }
  if (portfolio.status === 'fulfilled') state.portfolio = portfolio.value;
  if (status.status === 'fulfilled') state.status = status.value;
  renderHeader();
  renderCurrentView();
}

async function loadPrices() {
  try {
    const { prices } = await api('/api/prices');
    const previous = state.prices;
    state.prices = prices || {};
    for (const [symbol, p] of Object.entries(state.prices)) {
      const before = previous[symbol]?.price;
      if (Number.isFinite(before) && before !== p.price) {
        document.querySelectorAll(`[data-price="${symbol}"]`).forEach((el) => { el.textContent = fmtPrice(p.price); flash(el, p.price - before); });
      }
    }
    updateLiveDistances();
  } catch (error) {
    console.warn('prices unavailable', error.message);
  }
}

async function loadNotifications() {
  try {
    const { items } = await api('/api/notifications');
    if (state.seenNotifications) {
      const fresh = (items || []).filter((n) => !state.seenNotifications.has(n.id) && n.category === 'trade').slice(0, 3);
      for (const n of fresh.reverse()) toast(n.title, n.message);
    }
    state.seenNotifications = new Set((items || []).map((n) => n.id));
  } catch (error) {
    console.warn('notifications unavailable', error.message);
  }
}

async function loadVerdict() {
  state.verdict = await api('/api/backtest-verdict').catch(() => null);
  renderVerdict();
}

async function loadAccuracy() {
  [state.accuracy, state.paper] = await Promise.all([
    api('/api/predictions/accuracy').catch(() => null),
    api('/api/paper/breakout').catch(() => null)
  ]);
  renderAccuracy();
  renderPaper();
}

function renderCurrentView() {
  if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'radar') renderRadar();
  else if (state.view === 'coin') renderCoin();
  else if (state.view === 'settings') renderSettings();
}

// --- header + robot status -------------------------------------------------------
function robotStatus() {
  const s = state.status;
  if (!s) return { cls: '', title: 'Checking the robot...', sub: '' };
  if (s.stale) return { cls: 'bad', title: 'The engine has not checked in', sub: `Last check ${fmtAgo(s.ageMs)}. Check the GitHub Actions workflow.` };
  const next = s.nextTickEta ? Date.parse(s.nextTickEta) - Date.now() : null;
  const nextText = next == null ? '' : next > 0 ? `, next in ~${Math.max(1, Math.round(next / 60000))} min` : ', next any moment';
  const sub = `Last check ${fmtAgo(s.ageMs)}${nextText}.`;
  if (s.halt) return { cls: 'warn', title: 'New entries are paused', sub: `${s.halt.reason}. ${sub}` };
  if (!s.autoTradeEnabled) return { cls: 'warn', title: 'Watching only', sub: `Auto-trade is off, so the robot won't open trades. ${sub}` };
  return { cls: 'ok', title: 'Robot is running', sub };
}

function renderHeader() {
  const status = robotStatus();
  const pill = $('enginePill');
  pill.className = `engine-pill ${status.cls}`;
  $('enginePillText').textContent = state.status?.stale ? 'Engine stale' : state.status ? `Checked ${fmtAgo(state.status.ageMs)}` : 'Engine';
  pill.title = status.sub;
  const p = state.portfolio;
  if (p) $('headerBalance').textContent = fmtIdr(p.equityIdr ?? p.balanceIdr);
}

// --- dashboard -------------------------------------------------------------------
function renderDashboard() {
  const status = robotStatus();
  $('statusRing').className = `status-ring ${status.cls}`;
  $('statusTitle').textContent = status.title;
  $('statusSub').textContent = status.sub;
  const inPlay = state.coins.filter((c) => ['ready', 'setting-up'].includes(stageOf(c))).length;
  const positions = Object.keys(state.portfolio?.positions || {}).length;
  const max = state.settings?.maxOpenPositions ?? '-';
  $('statusChips').innerHTML = [
    `<span class="pill ${inPlay ? 'warn' : ''}">${inPlay} coin${inPlay === 1 ? '' : 's'} setting up</span>`,
    `<span class="pill">${positions}/${max} positions</span>`,
    state.settings ? `<span class="pill">Risk ${state.settings.riskPerTradePct}% per trade</span>` : ''
  ].join('');

  renderDecision();
  renderEquity();
  renderFiring();
  renderPositions();
  renderActivity();
  renderVerdict();
  renderAccuracy();
  renderPaper();
}

function renderDecision() {
  // Every enabled strategy of every coin not held, not just each coin's
  // headline, so a 4h check with coins set up isn't hidden behind a daily one.
  const all = state.coins.flatMap((coin) => (headline(coin)?.stage === 'holding' ? [] : Object.values(coin.prediction?.byProfile || {}))
    .filter((h) => h.decisionAt).map((h) => ({ coin, h })));
  const upcoming = all.filter((x) => x.h.decisionAt > Date.now());
  const pool = upcoming.length ? upcoming : all;
  const inPlayOf = (list) => list.filter((x) => ['ready', 'setting-up'].includes(x.h.stage));
  const ring = $('decisionRing');
  if (!pool.length) {
    $('decisionCountdown').textContent = '-';
    $('decisionText').textContent = 'Waiting for the first engine check.';
    ring.dataset.deadline = '';
    return;
  }
  pool.sort((a, b) => a.h.decisionAt - b.h.decisionAt);
  const next = pool[0].h;
  const atNext = inPlayOf(pool.filter((x) => x.h.decisionAt === next.decisionAt));
  const laterPlay = inPlayOf(pool)[0] || null;
  $('decisionCountdown').dataset.deadline = String(next.decisionAt);
  ring.dataset.deadline = String(next.decisionAt);
  ring.dataset.period = String(TF_MS[next.timeframe]);
  ring.classList.toggle('signal', atNext.length > 0);
  const names = (list) => [...new Set(list.map((x) => base(x.coin.symbol)))].slice(0, 3).join(', ');
  let text;
  if (state.settings?.earlyEntry && inPlayOf(pool).length) {
    const soon = inPlayOf(pool);
    const checkTf = TF_MS[state.settings.earlyTf] ? state.settings.earlyTf : '5m';
    const nextCheck = Math.ceil(Date.now() / TF_MS[checkTf]) * TF_MS[checkTf];
    $('decisionCountdown').dataset.deadline = String(nextCheck);
    ring.dataset.deadline = String(nextCheck);
    ring.dataset.period = String(TF_MS[checkTf]);
    ring.classList.add('signal');
    text = `Buy early is on: checked every ${TF_WORD[checkTf]} candle, next at <b>${escapeHtml(fmtClock(nextCheck))}</b>. ${escapeHtml(names(soon))} could fire as soon as price breaks the trigger.`;
  } else if (state.settings?.earlyEntry) {
    // Buy early reacts to price, but only for coins whose setup (trend plus a
    // pullback) already stands on closed candles, and new setups only form at
    // a candle close. With none set up, that close is the next chance.
    text = `Buy early is on, but no coin has a setup ready to buy yet. New setups can only form when a candle closes: the next ${TF_WORD[next.timeframe]} close is at <b>${escapeHtml(fmtClock(next.decisionAt))}</b>.`;
  } else {
    const off = ' Buy early is off in Settings, so buys wait for the candle close.';
    if (atNext.length) {
      text = `The ${TF_WORD[next.timeframe]} candle closes at <b>${escapeHtml(fmtClock(next.decisionAt))}</b>. ${escapeHtml(names(atNext))} could fire then.${off}`;
    } else if (laterPlay) {
      const later = inPlayOf(pool.filter((x) => x.h.decisionAt === laterPlay.h.decisionAt));
      text = `Next ${TF_WORD[next.timeframe]} check at ${escapeHtml(fmtClock(next.decisionAt))}, no coin set up for it. ${escapeHtml(names(later))} could fire at the ${TF_WORD[laterPlay.h.timeframe]} close, ${escapeHtml(fmtClock(laterPlay.h.decisionAt))}.${off}`;
    } else {
      text = `No coin is set up yet. The next ${TF_WORD[next.timeframe]} check is at ${escapeHtml(fmtClock(next.decisionAt))}.${off}`;
    }
  }
  $('decisionText').innerHTML = text;
}

function renderEquity() {
  const p = state.portfolio;
  if (!p) return;
  const equity = p.equityIdr ?? p.balanceIdr;
  animateNumber($('equityValue'), equity, fmtIdr);
  const ret = p.totalReturnPct ?? 0;
  $('returnValue').innerHTML = `<span class="${ret >= 0 ? 'up' : 'down'}">${fmtPct(ret)}</span> since start (${fmtIdr(p.initialBalanceIdr)})`;
  $('cashValue').textContent = fmtIdrShort(p.balanceIdr);
  $('positionsValue').textContent = fmtIdrShort(equity - p.balanceIdr);
  $('realizedValue').textContent = fmtIdrShort(p.realizedProfitIdr || 0);
}

function segmentsHtml(h, key) {
  if (!h?.conditions) return '';
  const prev = state.lastSegments[key] || [];
  const now = h.conditions.map((c) => (c.na ? 'na' : c.ok ? 'on' : 'off'));
  state.lastSegments[key] = now;
  return `<div class="segments" aria-label="${h.met} of ${h.total} conditions met">${now.map((s, i) => {
    const pop = s === 'on' && prev[i] && prev[i] !== 'on' ? ' pop' : '';
    const signal = s === 'on' && h.stage === 'setting-up' && i >= 4 ? ' signal' : '';
    return `<span class="seg ${s}${pop}${signal}" title="${escapeHtml(h.conditions[i].label)}"></span>`;
  }).join('')}</div>`;
}

function triggerLine(coin, h) {
  if (!h) return 'Not enough data yet.';
  if (h.stage === 'holding') return `Stop at <b>${fmtPrice(h.stopPrice)}</b> (${h.distanceToStopPct}% away)`;
  if (h.stage === 'ready') return `Would buy near <b>${fmtPrice(h.plan?.entryPrice ?? livePrice(coin))}</b> if the candle closes like this`;
  if (h.stage === 'setting-up') {
    return `Buys if the ${TF_LABEL[h.timeframe]} candle closes above <b>${fmtPrice(h.trigger.price)}</b> <span class="muted" data-dist="${coin.symbol}" data-trigger="${h.trigger.price}">${distanceText(h.trigger.price, livePrice(coin))}</span>`;
  }
  if (h.stage === 'watching') {
    return h.conditions.find((c) => c.key === 'tfTrend')?.ok
      ? 'Uptrend intact, waiting for a pullback to the EMA20'
      : `Waiting for the ${TF_WORD[h.timeframe]} chart to turn up again`;
  }
  const failing = h.conditions.filter((c) => !c.ok && !c.na)[0];
  return failing ? `Waiting because ${escapeHtml(failing.failText)}` : 'Not in play';
}

function distanceText(trigger, price) {
  if (!Number.isFinite(trigger) || !Number.isFinite(price)) return '';
  const d = ((trigger - price) / price) * 100;
  return d > 0 ? `(${d.toFixed(2)}% above now)` : '(price is above it now)';
}

function updateLiveDistances() {
  document.querySelectorAll('[data-dist]').forEach((el) => {
    const coin = coinBySymbol(el.dataset.dist);
    if (coin) el.textContent = distanceText(Number(el.dataset.trigger), livePrice(coin));
  });
}

function rankCoins(coins) {
  return [...coins].sort((a, b) => {
    const ha = headline(a), hb = headline(b);
    return (STAGE_ORDER[stageOf(a)] - STAGE_ORDER[stageOf(b)])
      || ((hb?.met ?? 0) / (hb?.total || 1) - (ha?.met ?? 0) / (ha?.total || 1))
      || ((ha?.decisionAt ?? Infinity) - (hb?.decisionAt ?? Infinity));
  });
}

function renderFiring() {
  const list = $('firingList');
  if (!state.coins.length) { list.innerHTML = '<div class="empty">No coins scanned yet. The robot fills this in on its next check.</div>'; return; }
  const ranked = rankCoins(state.coins.filter((c) => stageOf(c) !== 'holding'));
  const top = ranked.filter((c) => stageOf(c) !== 'blocked').slice(0, 3);
  if (!top.length) {
    list.innerHTML = `<div class="empty">Nothing is close to firing. ${ranked.length} coins are out of play right now, mostly because their trend is down.</div>`;
    return;
  }
  list.innerHTML = top.map((coin, i) => {
    const h = headline(coin);
    const period = TF_MS[h.timeframe];
    return `<div class="card fire-card enter" style="--i:${i}" data-open="${coin.symbol}">
      <div class="fire-head">
        <div class="coin-name"><span class="coin-dot">${escapeHtml(base(coin.symbol).slice(0, 4))}</span><div><b>${escapeHtml(base(coin.symbol))}</b><small>${escapeHtml(shortProfile(h))}</small></div></div>
        <span class="stage-chip ${h.stage}">${STAGE_LABEL[h.stage]}</span>
      </div>
      ${segmentsHtml(h, `fire-${coin.symbol}`)}
      <div class="fire-trigger">${triggerLine(coin, h)}</div>
      <div class="fire-foot">
        <svg class="ring sm" viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-track" cx="22" cy="22" r="19"/><circle class="ring-fill ${h.stage === 'ready' ? 'bull' : 'signal'}" data-deadline="${h.decisionAt}" data-period="${period}" cx="22" cy="22" r="19"/></svg>
        <span>Decides in <span class="count" data-deadline="${h.decisionAt}">${fmtCountdown(h.decisionAt - Date.now())}</span></span>
        ${h.plan?.riskIdr ? `<span style="margin-left:auto">Risk ${fmtIdrShort(h.plan.riskIdr)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  bindOpeners(list);
  tickClock();
}

function exitBarHtml(exit) {
  const stop = exit.stopPrice, entry = exit.entryPrice, price = exit.livePrice;
  const points = [stop, entry, price, exit.breakevenArmPrice].filter(Number.isFinite);
  const lo = Math.min(...points), hi = Math.max(...points);
  const pad = (hi - lo) * 0.12 || entry * 0.01;
  const pos = (v) => `${(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(1)}%`;
  return `<div class="exit-bar">
      <span class="marker stop" style="left:${pos(stop)}" title="Stop ${fmtPrice(stop)}"></span>
      <span class="marker entry" style="left:${pos(entry)}" title="Entry ${fmtPrice(entry)}"></span>
      ${Number.isFinite(exit.breakevenArmPrice) ? `<span class="marker be" style="left:${pos(exit.breakevenArmPrice)}" title="Breakeven arms at ${fmtPrice(exit.breakevenArmPrice)}"></span>` : ''}
      <span class="marker price" style="left:${pos(price)}" title="Now ${fmtPrice(price)}"></span>
    </div>
    <div class="exit-labels"><span class="down">Stop ${fmtPrice(stop)}</span><span>${Number.isFinite(exit.breakevenArmPrice) ? `Breakeven at ${fmtPrice(exit.breakevenArmPrice)}` : exit.stopKind === 'trailing' ? 'Trailing stop active' : 'Stop at breakeven'}</span></div>`;
}

function renderPositions() {
  const list = $('positionsList');
  const positions = Object.values(state.portfolio?.positions || {});
  if (!positions.length) { list.innerHTML = '<div class="empty">No open positions. The robot buys when a coin on the radar reaches "Ready" and the candle closes.</div>'; return; }
  list.innerHTML = positions.map((pos, i) => {
    const coin = coinBySymbol(pos.symbol);
    const exit = coin?.prediction?.exit;
    const pnl = pos.unrealizedProfitIdr ?? 0;
    return `<div class="card position-card enter" style="--i:${i}" data-open="${pos.symbol}">
      <div class="position-head">
        <div class="coin-name"><span class="coin-dot">${escapeHtml(base(pos.symbol).slice(0, 4))}</span><div><b>${escapeHtml(base(pos.symbol))}</b><small>${escapeHtml(shortProfile(exit) || pos.profile || "")} · entry ${fmtPrice(pos.entryPrice)}</small></div></div>
        <div class="row-right"><b class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${fmtIdrShort(pnl)}</b><span class="muted small">${exit?.rNow != null ? `${exit.rNow >= 0 ? '+' : ''}${exit.rNow}R` : fmtPct(pos.unrealizedProfitPct ?? 0)}</span></div>
      </div>
      ${exit ? exitBarHtml(exit) : ''}
      ${exit?.nextCheckAt ? `<div class="muted small">Stop checked when the ${TF_WORD[exit.timeframe]} candle closes, in <span data-deadline="${exit.nextCheckAt}">${fmtCountdown(exit.nextCheckAt - Date.now())}</span>${exit.timeStopAt ? `. Exits by ${escapeHtml(fmtClock(exit.timeStopAt))} unless it reaches +0.5R.` : '.'}</div>` : ''}
    </div>`;
  }).join('');
  bindOpeners(list);
}

function renderActivity() {
  const list = $('activityList');
  const items = state.status?.activity || [];
  if (!items.length) { list.innerHTML = '<div class="muted small">Nothing yet. Trades, skipped signals and pauses show up here.</div>'; return; }
  list.innerHTML = items.slice(0, 12).map((item) => {
    const when = fmtAgo(Date.now() - Date.parse(item.at));
    if (item.kind === 'fill') {
      const buy = item.type === 'BUY';
      const pnl = item.realizedProfitIdr != null && !buy ? ` · ${item.realizedProfitIdr >= 0 ? '+' : ''}${fmtIdrShort(item.realizedProfitIdr)}` : '';
      return `<div class="activity-item"><span class="icon ${buy ? 'buy' : 'sell'}">${buy ? 'B' : 'S'}</span><div><b>${buy ? 'Bought' : item.partial ? 'Sold part of' : 'Sold'} ${escapeHtml(base(item.symbol))}</b> at ${fmtPrice(item.price)}${pnl}<small>${escapeHtml(item.reason || '')} · ${when}</small></div></div>`;
    }
    if (item.kind === 'pause') return `<div class="activity-item"><span class="icon pause">!</span><div><b>Entries paused</b><small>${escapeHtml(item.reason)} · ${when}</small></div></div>`;
    return `<div class="activity-item"><span class="icon skip">-</span><div>Skipped ${escapeHtml(base(item.symbol))}<small>${escapeHtml(item.reason || '')} · ${when}</small></div></div>`;
  }).join('');
}

function renderVerdict() {
  const v = state.verdict;
  const badge = $('verdictBadge');
  if (!v?.available) { badge.className = 'pill'; badge.textContent = 'None'; $('verdictMeta').textContent = 'No backtest run yet. Run one to see how the current rules did recently.'; return; }
  badge.className = `pill ${v.verdict === 'Deploy' ? 'good' : v.verdict === 'Abandon' ? 'bad' : 'warn'}`;
  badge.textContent = `${v.verdict} · ${v.totalScore}/100`;
  const s = v.benchmarkSummary || {};
  $('verdictMeta').textContent = `${s.months ?? '?'} month${s.months === 1 ? '' : 's'}: ${s.closedTrades ?? 0} trades, return ${fmtPct(s.totalReturnPct ?? 0)}, win rate ${s.winRate ?? '-'}%, max drawdown ${s.maxDrawdownPct ?? '-'}%${s.openAtEnd ? `, ${s.openAtEnd} still open` : ''}. Run ${new Date(v.generatedAtIso).toLocaleString()}.`;
}

// Each signal predicts "+1R before the stop". Scores are only useful if higher
// scores hit more often, which the AUC line and the per-score rows show.
function renderAccuracy() {
  const a = state.accuracy;
  const badge = $('accuracyBadge');
  const one = a?.levels?.['1R'];
  if (!one || !one.overall.decided) {
    badge.className = 'pill';
    badge.textContent = a?.signals ? `${a.signals} waiting` : 'None';
    $('accuracyMeta').textContent = a?.signals
      ? `${a.signals} signal${a.signals === 1 ? '' : 's'} recorded, none decided yet. A signal counts once it reaches +1R or its stop.`
      : 'No signals recorded yet. Every setup the robot flags, taken or skipped, is tracked here.';
    $('accuracyBuckets').innerHTML = '';
    return;
  }
  const rate = one.overall.hitRatePct;
  badge.className = `pill ${rate >= 50 ? 'good' : rate >= 40 ? 'warn' : 'bad'}`;
  badge.textContent = `${rate}% hit +1R`;
  const two = a.levels['2R']?.overall;
  const auc = one.scoreAucPct;
  $('accuracyMeta').textContent = `${one.overall.hits} of ${one.overall.decided} signals reached +1R before the stop${two?.decided ? `, ${two.hitRatePct}% reached +2R` : ''}. ${a.pending} still open.`
    + (auc != null ? ` Score vs outcome: ${auc}/100 (50 means the confidence score does not predict wins).` : '');
  $('accuracyBuckets').innerHTML = one.byScore.filter((b) => b.decided).map((b) =>
    `<div class="activity-item"><span class="icon">${escapeHtml(b.bucket)}</span><div>${b.hitRatePct}% hit +1R<small>${b.hits} of ${b.decided} signals with score ${escapeHtml(b.bucket)}</small></div></div>`
  ).join('');
}

// Paper-only daily breakout entry, recorded next to the live robot. Results
// are what each signal would have made with a 2x ATR stop and a fixed target.
function renderPaper() {
  const p = state.paper;
  const badge = $('paperBadge');
  const rules = p?.rules || [];
  const closed = rules.reduce((s, r) => s + r.closed, 0);
  const signals = rules.reduce((s, r) => s + r.signals, 0);
  if (!closed) {
    badge.className = 'pill';
    badge.textContent = signals ? `${signals} open` : 'Watching';
    $('paperMeta').textContent = 'Paper only, no trades placed. Records a signal when a coin closes above its 20- or 55-day high while BTC is above its 200-day average.'
      + (signals ? ` ${signals} signal${signals === 1 ? '' : 's'} still open.` : ' None yet.');
  } else {
    const totalR = Math.round(rules.reduce((s, r) => s + r.totalR, 0) * 100) / 100;
    badge.className = `pill ${totalR > 0 ? 'good' : totalR < 0 ? 'bad' : 'warn'}`;
    badge.textContent = `${totalR > 0 ? '+' : ''}${totalR}R`;
    $('paperMeta').textContent = `Paper only, no trades placed. ${closed} closed, ${signals - closed} open, after ${p.costPct}% costs.`;
  }
  $('paperRules').innerHTML = rules.map((r) =>
    `<div class="activity-item"><span class="icon">+${r.targetR}R</span><div>${escapeHtml(r.label)}<small>${r.closed ? `${r.closed} closed, ${r.winPct}% wins, avg ${r.avgR}R per trade` : 'no closed trades yet'}${r.open ? `, ${r.open} open` : ''}</small></div></div>`
  ).join('');
}

document.querySelectorAll('#backtestMonthsRow button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('#backtestMonthsRow button').forEach((b) => b.classList.toggle('active', b === btn));
  state.backtestMonths = Number(btn.dataset.months);
}));
$('runBacktestBtn').addEventListener('click', async () => {
  const btn = $('runBacktestBtn');
  btn.disabled = true;
  btn.textContent = 'Running, this takes up to a minute...';
  try {
    state.verdict = await api('/api/backtest/run', { method: 'POST', body: { months: state.backtestMonths } });
    renderVerdict();
  } catch (error) {
    $('verdictMeta').textContent = `Backtest failed: ${error.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run backtest';
  }
});

function bindOpeners(root) {
  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openCoin(el.dataset.open)));
}

// --- radar -----------------------------------------------------------------------
function renderRadar() {
  const list = $('radarList');
  if (state.stageFilter === 'movers') { renderMovers(list); return; }
  const q = state.search.trim().toUpperCase();
  let coins = rankCoins(state.coins);
  if (q) coins = coins.filter((c) => c.symbol.includes(q));
  if (state.stageFilter !== 'all') coins = coins.filter((c) => stageOf(c) === state.stageFilter);
  if (!state.coins.length) { list.innerHTML = '<div class="empty">No coins scanned yet.</div>'; return; }
  if (!coins.length) { list.innerHTML = '<div class="empty">No coins match this filter.</div>'; return; }
  list.innerHTML = coins.map((coin, i) => {
    const h = headline(coin);
    const change = liveChange(coin);
    const stage = stageOf(coin);
    const when = h?.decisionAt && stage !== 'holding' && stage !== 'blocked' ? ` · decides in <span data-deadline="${h.decisionAt}">${fmtCountdown(h.decisionAt - Date.now())}</span>` : '';
    return `<div class="row enter" style="--i:${Math.min(i, 12)}" data-open="${coin.symbol}">
      <div class="coin-name"><span class="coin-dot">${escapeHtml(base(coin.symbol).slice(0, 4))}</span><div><b>${escapeHtml(base(coin.symbol))}</b><small>${escapeHtml(shortProfile(h))}</small></div></div>
      <div class="row-mid">
        <div style="display:flex;align-items:center;gap:8px"><span class="stage-chip ${stage}">${STAGE_LABEL[stage]}</span>${h?.total ? `<span class="muted small">${h.met}/${h.total}</span>` : ''}</div>
        ${stage !== 'holding' ? segmentsHtml(h, `radar-${coin.symbol}`) : ''}
        <div class="muted">${triggerLine(coin, h)}${when}</div>
      </div>
      <div class="row-right"><b data-price="${coin.symbol}">${fmtPrice(livePrice(coin))}</b><span class="change ${change >= 0 ? 'up' : 'down'}">${fmtPct(change)}</span></div>
    </div>`;
  }).join('');
  bindOpeners(list);
}

async function renderMovers(list) {
  list.innerHTML = '<div class="skeleton-card"></div>';
  try {
    const { movers, error } = await api('/api/movers');
    state.movers = movers || [];
    state.moversError = error;
  } catch (error) {
    state.moversError = error.message;
  }
  if (state.stageFilter !== 'movers') return;
  if (state.moversError) { list.innerHTML = `<div class="empty">Top movers unavailable: ${escapeHtml(state.moversError)}</div>`; return; }
  const watch = new Set(state.settings?.watchlist || []);
  list.innerHTML = state.movers.map((m, i) => `<div class="row enter" style="--i:${i}">
      <div class="coin-name"><span class="coin-dot">${escapeHtml(base(m.symbol).slice(0, 4))}</span><div><b>${escapeHtml(base(m.symbol))}</b><small>24h volume $${Math.round(m.quoteVolume / 1e6)}M</small></div></div>
      <div class="row-mid"><span class="muted">${watch.has(m.symbol) ? 'On your watchlist' : 'Not on your watchlist'}</span></div>
      <div class="row-right"><b>${fmtPrice(m.price)}</b><span class="change ${m.changePct >= 0 ? 'up' : 'down'}">${fmtPct(m.changePct)}</span>
      ${watch.has(m.symbol) ? '' : `<button class="link-btn" data-add="${m.symbol}">Add to watchlist</button>`}</div>
    </div>`).join('') || '<div class="empty">No movers right now.</div>';
  list.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    await saveSettings({ watchlist: [...(state.settings?.watchlist || []), btn.dataset.add] }).catch((e) => toast('Could not add coin', e.message));
    btn.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'Added. It appears after the next check.' }));
  }));
}

document.querySelectorAll('#stageFilter .chip').forEach((chip) => chip.addEventListener('click', () => {
  state.stageFilter = chip.dataset.stage;
  document.querySelectorAll('#stageFilter .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderRadar();
}));
$('radarSearch').addEventListener('input', (e) => { state.search = e.target.value; renderRadar(); });
$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  try {
    const result = await api('/api/coins/refresh-all', { method: 'POST' });
    if (result.skipped === 'recent') toast('Already up to date', 'The engine checked less than a minute ago.');
    await Promise.all([loadCore(), loadPrices()]);
  } catch (error) {
    toast('Check failed', error.message);
  } finally {
    btn.disabled = false;
  }
});

// --- coin detail -------------------------------------------------------------------
function planFor(coin) {
  const p = coin?.prediction;
  if (!p) return null;
  if (p.exit) return p.exit;
  const keys = Object.keys(p.byProfile || {});
  if (!keys.length) return p.headline;
  if (!state.planProfile || !p.byProfile[state.planProfile]) state.planProfile = p.headline?.profile || keys[0];
  return p.byProfile[state.planProfile];
}

function renderCoin() {
  const coin = coinBySymbol(state.coinSymbol);
  $('coinSymbol').textContent = state.coinSymbol || '-';
  if (!coin) {
    $('planSentence').textContent = 'This coin has not been scanned yet. It appears after the next engine check.';
    ['planStepper', 'planHighlight', 'planBlockers', 'planChecklist', 'planTrade', 'planTabs'].forEach((id) => { $(id).innerHTML = ''; });
    return;
  }
  const price = livePrice(coin);
  const priceEl = $('coinPrice');
  priceEl.dataset.price = coin.symbol;
  priceEl.textContent = fmtPrice(price);
  const change = liveChange(coin);
  $('coinChange').className = `change ${change >= 0 ? 'up' : 'down'}`;
  $('coinChange').textContent = `${fmtPct(change)} today`;
  $('watchlistStar').classList.toggle('active', (state.settings?.watchlist || []).includes(coin.symbol));

  const plan = planFor(coin);
  const stage = plan?.stage || 'blocked';
  $('coinStage').className = `stage-chip ${stage}`;
  $('coinStage').textContent = STAGE_LABEL[stage];

  const profiles = Object.values(coin.prediction?.byProfile || {});
  $('planTabs').innerHTML = profiles.length > 1 ? `<div class="segmented small" role="group" aria-label="Strategy">${profiles.map((p) => `<button class="${p.profile === state.planProfile ? 'active' : ''}" data-profile="${p.profile}">${escapeHtml(shortProfile(p))}</button>`).join('')}</div>` : '';
  $('planTabs').querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', () => { state.planProfile = b.dataset.profile; state.chartTf = null; renderCoin(); loadChart().catch(console.error); }));

  if (stage === 'holding') renderExitPlan(coin, plan);
  else renderEntryPlan(coin, plan);

  renderDetails(coin);
  renderActionBar(coin, plan);
  if (state.chartCandles.length) drawChart();
  tickClock();
}

function stepperHtml(plan) {
  const ok = (k) => plan.conditions.find((c) => c.key === k)?.ok || plan.conditions.find((c) => c.key === k)?.na;
  const steps = [
    { label: 'Trend', done: ['htfTrend', 'btcGate', 'tradeable', 'tfTrend'].every(ok) },
    { label: 'Pullback', done: ok('pullback') },
    { label: 'Reclaim', done: ok('reclaim') && ok('noChase') },
    { label: 'Buy', done: false }
  ];
  let currentSet = false;
  return steps.map((s) => {
    let cls = s.done ? 'done' : '';
    if (!s.done && !currentSet) { cls = 'current'; currentSet = true; }
    return `<li class="${cls}">${s.label}</li>`;
  }).join('');
}

function renderEntryPlan(coin, plan) {
  if (!plan) { $('planSentence').textContent = 'Not enough data yet.'; return; }
  const sentence = plan.profile === headline(coin)?.profile ? coin.prediction.sentence : null;
  $('planSentence').textContent = sentence || triggerLine(coin, plan).replace(/<[^>]+>/g, '');
  $('planStepper').innerHTML = stepperHtml(plan);
  const period = TF_MS[plan.timeframe];
  const highlight = plan.stage === 'setting-up' || plan.stage === 'ready'
    ? `<div><div class="muted">${plan.stage === 'ready' ? 'Buys at the candle close if it holds' : 'Buy trigger: close above'}</div><div class="big-number">${fmtPrice(plan.stage === 'ready' ? (plan.plan?.entryPrice ?? plan.trigger.livePrice) : plan.trigger.price)}</div>
       <div class="muted" data-dist="${coin.symbol}" data-trigger="${plan.trigger.price}">${distanceText(plan.trigger.price, livePrice(coin))}</div></div>`
    : `<div><div class="muted">Next check</div><div class="big-number">${escapeHtml(plan.decisionLabel)}</div><div class="muted">${plan.stage === 'watching' ? 'Waiting for a pullback to the EMA20.' : 'Not in play until the trend turns up.'}</div></div>`;
  $('planHighlight').innerHTML = `
    <svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-track" cx="22" cy="22" r="19"/><circle class="ring-fill ${plan.stage === 'ready' ? 'bull' : 'signal'}" data-deadline="${plan.decisionAt}" data-period="${period}" cx="22" cy="22" r="19"/></svg>
    ${highlight}
    <div style="margin-left:auto;text-align:right"><div class="muted">${TF_LABEL[plan.timeframe]} candle closes in</div><div class="big-number" data-deadline="${plan.decisionAt}">${fmtCountdown(plan.decisionAt - Date.now())}</div><div class="muted small">${escapeHtml(plan.decisionLabel)}, robot acts within ~5-15 min</div></div>`;
  $('planBlockers').innerHTML = plan.blockers?.length && plan.stage !== 'blocked'
    ? `<div class="blockers">${plan.blockers.map((b) => `<div>${escapeHtml(b)}</div>`).join('')}</div>` : '';
  $('planChecklist').innerHTML = plan.conditions.map((c) => `<div class="check ${c.na ? '' : c.ok ? 'ok' : 'fail'}">
      <span class="mark">${c.na ? '-' : c.ok ? '&#10003;' : '&#10007;'}</span>
      <div>${escapeHtml(c.label)}<small>${escapeHtml(c.detail)}</small></div></div>`).join('')
    + (plan.pullbackValidFor > 0 && plan.stage !== 'blocked' ? `<div class="muted small" style="margin-top:8px">The pullback still counts for the next ${plan.pullbackValidFor} candle${plan.pullbackValidFor === 1 ? '' : 's'}.</div>` : '');
  $('planTrade').innerHTML = plan.plan ? `
    <div class="kv"><span>Expected entry</span><b>${fmtPrice(plan.plan.entryPrice)}</b></div>
    <div class="kv"><span>Stop-loss</span><b>${fmtPrice(plan.plan.stopPrice)}</b> <span>${plan.plan.stopDistancePct}% below entry</span></div>
    <div class="kv"><span>Position size</span><b>${fmtIdr(plan.plan.positionIdr)}</b></div>
    <div class="kv"><span>Money at risk</span><b>${fmtIdr(plan.plan.riskIdr)}</b></div>` : '';
}

function renderExitPlan(coin, exit) {
  const pos = state.portfolio?.positions?.[coin.symbol];
  $('planSentence').textContent = coin.prediction.sentence;
  $('planStepper').innerHTML = '<li class="done">Trend</li><li class="done">Pullback</li><li class="done">Reclaim</li><li class="done">Bought</li>';
  const pnl = pos?.unrealizedProfitIdr ?? 0;
  $('planHighlight').innerHTML = `
    <div><div class="muted">Open result</div><div class="big-number ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${fmtIdr(pnl)}</div><div class="muted">${exit.rNow != null ? `${exit.rNow >= 0 ? '+' : ''}${exit.rNow}R` : ''}</div></div>
    ${exit.nextCheckAt ? `<div style="margin-left:auto;text-align:right"><div class="muted">Next stop check in</div><div class="big-number" data-deadline="${exit.nextCheckAt}">${fmtCountdown(exit.nextCheckAt - Date.now())}</div><div class="muted small">${escapeHtml(exit.nextCheckLabel || '')}</div></div>` : ''}`;
  $('planBlockers').innerHTML = '';
  $('planChecklist').innerHTML = `<div style="margin-bottom:12px">${exitBarHtml(exit)}</div>`;
  $('planTrade').innerHTML = `
    <div class="kv"><span>Entry</span><b>${fmtPrice(exit.entryPrice)}</b></div>
    <div class="kv"><span>Stop (${escapeHtml(exit.stopKind)})</span><b>${fmtPrice(exit.stopPrice)}</b> <span>${exit.distanceToStopPct}% away</span></div>
    <div class="kv"><span>Breakeven arms at</span><b>${exit.breakevenArmPrice ? fmtPrice(exit.breakevenArmPrice) : 'Already armed'}</b></div>
    <div class="kv"><span>Time stop</span><b>${exit.timeStopAt ? escapeHtml(fmtClock(exit.timeStopAt)) : 'Not active'}</b></div>`;
}

function renderDetails(coin) {
  $('summaryText').textContent = coin.summary?.text || '-';
  const l = coin.latest || {};
  const cells = [
    ['Daily RSI14', l.rsi14?.toFixed?.(1)], ['Daily ADX14', l.adx14?.toFixed?.(1)], ['Daily ATR', l.atrPct != null ? `${l.atrPct.toFixed(2)}%` : null],
    ['Daily EMA20', fmtPrice(l.ema20)], ['Daily EMA50', fmtPrice(l.ema50)], ['Setup score', coin.entryOrExit?.confidencePct != null ? `${coin.entryOrExit.confidencePct}` : null]
  ];
  $('indicatorGrid').innerHTML = cells.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v ?? '-')}</b></div>`).join('');
  const s = state.chartStructure;
  const sr = s?.supportResistance || {};
  $('structureGrid').innerHTML = s ? [
    ['Structure', s.signal?.type && s.signal.type !== 'None' ? `${s.signal.type} ${s.signal.direction}` : s.trend || '-'],
    ['Nearest support', sr.support?.[0] ? fmtPrice(sr.support[0].price) : '-'],
    ['Nearest resistance', sr.resistance?.[0] ? fmtPrice(sr.resistance[0].price) : '-']
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('') : '';
}

function renderActionBar(coin, plan) {
  const pos = state.portfolio?.positions?.[coin.symbol];
  $('buyBtn').disabled = Boolean(pos);
  $('sellBtn').disabled = !pos;
  $('positionDetail').textContent = pos
    ? `Holding ${Number(pos.quantity).toPrecision(6)} ${base(coin.symbol)} since ${new Date(pos.openedAt).toLocaleString()}.`
    : 'Manual trades use the same stop-loss and risk sizing as the robot.';
}

$('watchlistStar').addEventListener('click', async () => {
  const symbol = state.coinSymbol;
  const list = state.settings?.watchlist || [];
  const next = list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol];
  await saveSettings({ watchlist: next }).catch((e) => toast('Could not update watchlist', e.message));
  renderCoin();
});
$('buyBtn').addEventListener('click', () => manualTrade('BUY'));
$('sellBtn').addEventListener('click', () => manualTrade('SELL'));

async function manualTrade(action) {
  const symbol = state.coinSymbol;
  if (!confirm(`Place a paper ${action} on ${base(symbol)}? This uses paper money only.`)) return;
  const btn = action === 'BUY' ? $('buyBtn') : $('sellBtn');
  btn.disabled = true;
  try {
    await api(`/api/coins/${symbol}/trade`, { method: 'POST', body: { action } });
    toast(`Paper ${action.toLowerCase()} placed`, `${base(symbol)} ${action === 'BUY' ? 'bought' : 'sold'}.`);
    await Promise.all([loadCore(), loadNotifications()]);
  } catch (error) {
    toast(`${action} failed`, error.message);
  } finally {
    renderCoin();
  }
}

// --- chart ------------------------------------------------------------------------
async function loadChart() {
  const coin = coinBySymbol(state.coinSymbol);
  const plan = planFor(coin);
  if (!state.chartTf) state.chartTf = plan?.timeframe || '4h';
  renderTfRow();
  const res = await api(`/api/coins/${state.coinSymbol}/candles?tf=${state.chartTf}`);
  state.chartCandles = res.candles || [];
  state.chartStructure = res.structure;
  state.chartHighlight = null;
  $('chartDetail').textContent = 'Tap a candle to inspect it';
  drawChart();
  if (coin) renderDetails(coin);
}

function renderTfRow() {
  $('tfRow').innerHTML = ['15m', '1h', '4h', '1d'].map((tf) => `<button class="${tf === state.chartTf ? 'active' : ''}" data-tf="${tf}">${TF_LABEL[tf]}</button>`).join('');
  $('tfRow').querySelectorAll('[data-tf]').forEach((b) => b.addEventListener('click', () => { state.chartTf = b.dataset.tf; loadChart().catch(console.error); }));
}

const CHART = { up: '#1A8F5A', down: '#D1433F', ema20: '#1F6FEB', ema50: '#9A988F', grid: '#EEEDE8', text: '#6B6A64', signal: '#C98A10', signalSoft: 'rgba(201,138,16,0.10)', stop: '#D1433F', entry: '#6B6A64' };

function drawChart() {
  const canvas = $('coinChart');
  const candles = state.chartCandles;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (!candles.length) return;

  const coin = coinBySymbol(state.coinSymbol);
  const plan = planFor(coin);
  const sameTf = plan && plan.timeframe === state.chartTf;
  ctx.font = '600 11px Inter, sans-serif';
  const widest = Math.max(...[...candles.map((c) => c.high), ...candles.map((c) => c.low)].map((p) => ctx.measureText(fmtPrice(p)).width));
  const pad = { l: 8, r: Math.ceil(widest) + 16, t: 12, b: 22 };
  const levels = [];
  if (sameTf && plan.stage !== 'holding' && ['setting-up', 'ready'].includes(plan.stage)) {
    levels.push({ price: plan.trigger.price, color: CHART.signal, dash: [6, 4], label: `Buy trigger ${fmtPrice(plan.trigger.price)}`, below: false });
    if (plan.plan?.stopPrice) levels.push({ price: plan.plan.stopPrice, color: CHART.stop, dash: [2, 4], label: `Planned stop ${fmtPrice(plan.plan.stopPrice)}`, below: true });
  }
  if (plan?.stage === 'holding') {
    levels.push({ price: plan.entryPrice, color: CHART.entry, dash: [], label: `Entry ${fmtPrice(plan.entryPrice)}`, below: false });
    levels.push({ price: plan.stopPrice, color: CHART.stop, dash: [6, 4], label: `Stop ${fmtPrice(plan.stopPrice)}`, below: true });
    if (plan.breakevenArmPrice) levels.push({ price: plan.breakevenArmPrice, color: CHART.signal, dash: [2, 4], label: `Breakeven at ${fmtPrice(plan.breakevenArmPrice)}`, below: false });
  }

  let min = Math.min(...candles.map((c) => c.low)), max = Math.max(...candles.map((c) => c.high));
  for (const l of levels) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
  const span = (max - min) || max * 0.01;
  min -= span * 0.04; max += span * 0.04;
  const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
  const x = (i) => pad.l + (candles.length === 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
  const y = (p) => pad.t + (1 - (p - min) / (max - min)) * plotH;
  const step = plotW / Math.max(1, candles.length - 1);

  ctx.strokeStyle = CHART.grid; ctx.lineWidth = 1; ctx.fillStyle = CHART.text; ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'left';
  for (let k = 0; k <= 4; k += 1) {
    const p = min + ((max - min) * k) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(w - pad.r, y(p)); ctx.stroke();
    ctx.fillText(fmtPrice(p), w - pad.r + 6, y(p) + 4);
  }

  const legend = [];
  if (sameTf && plan.stage !== 'holding' && plan.stage !== 'blocked' && candles.length > 6) {
    const a = x(candles.length - 6) - step / 2, b = x(candles.length - 2) + step / 2;
    ctx.fillStyle = CHART.signalSoft;
    ctx.fillRect(a, pad.t, b - a, plotH);
    legend.push('<span><i class="box" style="background:rgba(201,138,16,0.25)"></i>5-candle pullback window</span>');
  }

  const bodyW = Math.max(1, Math.min(step * 0.62, 10));
  candles.forEach((c, i) => {
    const col = c.close >= c.open ? CHART.up : CHART.down;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - bodyW / 2, top, bodyW, Math.max(1, y(Math.min(c.open, c.close)) - top));
  });
  if (candles.length > 1) {
    const i = candles.length - 1;
    ctx.globalAlpha = 0.25; ctx.fillStyle = CHART.text;
    ctx.fillRect(x(i) - step / 2, pad.t, step, plotH);
    ctx.globalAlpha = 1;
  }

  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    candles.forEach((c, i) => {
      if (!Number.isFinite(c[key])) { started = false; return; }
      if (!started) { ctx.moveTo(x(i), y(c[key])); started = true; } else ctx.lineTo(x(i), y(c[key]));
    });
    ctx.stroke();
  };
  line('ema50', CHART.ema50);
  line('ema20', CHART.ema20);
  legend.unshift(`<span><i style="border-color:${CHART.ema20}"></i>EMA20</span>`, `<span><i style="border-color:${CHART.ema50}"></i>EMA50</span>`);

  for (const l of levels) {
    ctx.strokeStyle = l.color; ctx.setLineDash(l.dash); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y(l.price)); ctx.lineTo(w - pad.r, y(l.price)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = l.color; ctx.textAlign = 'left'; ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText(l.label, pad.l + 4, y(l.price) + (l.below ? 14 : -5));
    legend.push(`<span><i class="${l.dash.length ? 'dash' : ''}" style="border-color:${l.color}"></i>${escapeHtml(l.label.split(' ').slice(0, -1).join(' '))}</span>`);
  }

  const last = candles.at(-1);
  ctx.fillStyle = last.close >= last.open ? CHART.up : CHART.down;
  ctx.fillRect(w - pad.r + 2, y(last.close) - 9, pad.r - 4, 18);
  ctx.fillStyle = '#fff'; ctx.font = '600 11px Inter, sans-serif';
  ctx.fillText(fmtPrice(last.close), w - pad.r + 6, y(last.close) + 4);

  ctx.fillStyle = CHART.text; ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'left'; ctx.fillText(shortDate(candles[0]), pad.l, h - 6);
  ctx.textAlign = 'right'; ctx.fillText(shortDate(last), w - pad.r, h - 6);

  if (state.chartHighlight != null && candles[state.chartHighlight]) {
    const i = state.chartHighlight;
    ctx.strokeStyle = 'rgba(29,28,26,0.35)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(i), pad.t); ctx.lineTo(x(i), pad.t + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!sameTf && plan && plan.stage !== 'holding') legend.push(`<span class="muted">Switch to ${TF_LABEL[plan.timeframe]} to see the buy trigger</span>`);
  $('chartLegend').innerHTML = legend.join('');
}

function shortDate(c) {
  const d = new Date(c.time * 1000);
  return state.chartTf === '1d' ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

$('coinChart').addEventListener('click', (event) => {
  const candles = state.chartCandles;
  if (!candles.length) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const plotW = rect.width - 8 - 64;
  const i = Math.max(0, Math.min(candles.length - 1, Math.round(((event.clientX - rect.left - 8) / plotW) * (candles.length - 1))));
  state.chartHighlight = i;
  drawChart();
  const c = candles[i];
  $('chartDetail').textContent = `${shortDate(c)} · O ${fmtPrice(c.open)} H ${fmtPrice(c.high)} L ${fmtPrice(c.low)} C ${fmtPrice(c.close)}`;
});
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === 'coin') drawChart(); }, 120); });

// --- settings ----------------------------------------------------------------------
async function saveSettings(patch) {
  state.settings = await api('/api/settings', { method: 'POST', body: patch });
  return state.settings;
}

function note(id, text, cls = '') {
  const el = $(id);
  el.className = `form-note ${cls}`;
  el.textContent = text;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('autoTradeToggle').checked = s.autoTrade.enabled;
  const strategyEntries = Object.entries(s.strategyProfiles || {}).sort(([a], [b]) => (a === 'scalping') - (b === 'scalping'));
  $('strategyList').innerHTML = strategyEntries.map(([key, p]) => `
    <label class="strategy-row"><span><b>${escapeHtml(p.label)}</b><small>${key === 'scalping' ? 'Lost money in every backtest after costs. Use with care.' : `Trades ${TF_WORD[p.triggerTf]} candles, trend from ${TF_WORD[p.filterTf]} chart.`}</small></span>
    <input type="checkbox" role="switch" data-strategy="${key}" ${s.strategies?.[key] ? 'checked' : ''} /></label>`).join('');
  $('earlyEntryToggle').checked = Boolean(s.earlyEntry);
  $('setRiskPerTrade').value = s.riskPerTradePct;
  $('setMaxPositions').value = s.maxOpenPositions;
  $('setPortfolioRisk').value = s.maxPortfolioRiskPct;
  $('setDailyLoss').value = s.dailyLossLimitPct;
  $('setLossStreak').value = s.maxConsecutiveLosses;
  $('setMinScore').value = s.autoTrade.minConfidencePct;

  $('settingsWatchlist').innerHTML = s.watchlist.map((sym) => `<span class="tag">${escapeHtml(base(sym))}<button data-remove="${sym}" aria-label="Remove ${escapeHtml(sym)}">&times;</button></span>`).join('');
  $('settingsWatchlist').querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    try { await saveSettings({ watchlist: s.watchlist.filter((x) => x !== b.dataset.remove) }); renderSettings(); note('watchlistNote', 'Removed.', 'good'); }
    catch (e) { note('watchlistNote', e.message, 'bad'); }
  }));

  $('telegramToggle').checked = s.telegram.enabled;
  note('telegramStatus', s.telegram.configured ? 'Bot token and chat ID are saved.' : 'Not configured yet.');
  document.querySelectorAll('#aiModeToggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.ai.mode));
  $('aiOpenaiFields').classList.toggle('hidden', s.ai.mode !== 'openai');
  $('aiBaseUrl').value = s.ai.openaiBaseUrl || '';
  $('aiModel').innerHTML = (s.ai.availableModels || []).map((m) => `<option ${m === s.ai.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  note('aiStatus', s.ai.mode === 'openai' ? (s.ai.configured ? 'OpenAI key saved.' : 'Add an API key to use OpenAI.') : 'Local summaries: free and instant.');

  $('setInitialBalance').value = s.initialBalanceIdr;
  $('setUsdIdr').value = s.usdIdrRate;
  $('setAllocation').value = s.tradeAllocationPct;
  $('setCost').value = s.roundTripCostPct;
  $('setSlippage').value = s.slippagePct;
  $('setMinVolume').value = s.minTradeQuoteVolumeUsdt;
  $('setBinanceUrl').value = s.binanceBaseUrl;
  renderAdminTokenState();
}

function renderAdminTokenState() {
  const el = $('adminTokenState');
  if (el) el.textContent = readAdminToken() ? 'Admin token saved on this device.' : 'No admin token saved on this device.';
}

$('autoTradeToggle').addEventListener('change', async (e) => {
  try { await saveSettings({ autoTrade: { enabled: e.target.checked } }); note('tradingNote', e.target.checked ? 'Auto-trading is on.' : 'Auto-trading is off. The robot only watches.', 'good'); loadCore(); }
  catch (err) { e.target.checked = !e.target.checked; note('tradingNote', err.message, 'bad'); }
});
$('saveTrading').addEventListener('click', async () => {
  const strategies = {};
  document.querySelectorAll('[data-strategy]').forEach((el) => { strategies[el.dataset.strategy] = el.checked; });
  try {
    await saveSettings({
      strategies,
      earlyEntry: $('earlyEntryToggle').checked,
      autoTrade: { minConfidencePct: Number($('setMinScore').value) },
      riskPerTradePct: Number($('setRiskPerTrade').value),
      maxOpenPositions: Number($('setMaxPositions').value),
      maxPortfolioRiskPct: Number($('setPortfolioRisk').value),
      dailyLossLimitPct: Number($('setDailyLoss').value),
      maxConsecutiveLosses: Number($('setLossStreak').value)
    });
    renderSettings();
    note('tradingNote', 'Saved. Takes effect on the next engine check.', 'good');
  } catch (e) { note('tradingNote', e.message, 'bad'); }
});
$('addSymbolBtn').addEventListener('click', async () => {
  const raw = $('addSymbolInput').value.trim().toUpperCase();
  const symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
  if (!/^[A-Z0-9]{1,17}USDT$/.test(symbol)) { note('watchlistNote', 'Enter a Binance USDT pair, like DOGEUSDT.', 'bad'); return; }
  if (state.settings.watchlist.includes(symbol)) { note('watchlistNote', `${symbol} is already on the watchlist.`); return; }
  try {
    const next = await saveSettings({ watchlist: [...state.settings.watchlist, symbol] });
    $('addSymbolInput').value = '';
    renderSettings();
    note('watchlistNote', next.watchlist.includes(symbol) ? `${symbol} added. It appears after the next check.` : `${symbol} isn't allowed.`, next.watchlist.includes(symbol) ? 'good' : 'bad');
  } catch (e) { note('watchlistNote', e.message, 'bad'); }
});
$('addSymbolInput').addEventListener('input', () => note('watchlistNote', ''));
$('telegramToggle').addEventListener('change', async (e) => {
  try { await saveSettings({ telegram: { enabled: e.target.checked } }); renderSettings(); }
  catch (err) { e.target.checked = !e.target.checked; note('telegramStatus', err.message, 'bad'); }
});
$('saveTelegram').addEventListener('click', async () => {
  const telegram = {};
  if ($('telegramToken').value.trim()) telegram.botToken = $('telegramToken').value.trim();
  if ($('telegramChat').value.trim()) telegram.chatId = $('telegramChat').value.trim();
  if (!Object.keys(telegram).length) { note('telegramStatus', 'Enter a bot token or chat ID to save.', 'bad'); return; }
  try { await saveSettings({ telegram }); $('telegramToken').value = ''; $('telegramChat').value = ''; renderSettings(); note('telegramStatus', 'Saved.', 'good'); }
  catch (e) { note('telegramStatus', e.message, 'bad'); }
});
$('testTelegram').addEventListener('click', async () => {
  try { await api('/api/telegram/test', { method: 'POST' }); note('telegramStatus', 'Test message sent.', 'good'); }
  catch (e) { note('telegramStatus', e.message, 'bad'); }
});
document.querySelectorAll('#aiModeToggle button').forEach((b) => b.addEventListener('click', async () => {
  try { await saveSettings({ ai: { mode: b.dataset.mode } }); renderSettings(); }
  catch (e) { note('aiStatus', e.message, 'bad'); }
}));
$('saveAi').addEventListener('click', async () => {
  const ai = { openaiBaseUrl: $('aiBaseUrl').value.trim(), model: $('aiModel').value };
  if ($('aiApiKey').value.trim()) ai.openaiApiKey = $('aiApiKey').value.trim();
  try { await saveSettings({ ai }); $('aiApiKey').value = ''; renderSettings(); note('aiStatus', 'Saved.', 'good'); }
  catch (e) { note('aiStatus', e.message, 'bad'); }
});
$('saveAdvanced').addEventListener('click', async () => {
  try {
    await saveSettings({
      initialBalanceIdr: Number($('setInitialBalance').value),
      usdIdrRate: Number($('setUsdIdr').value),
      tradeAllocationPct: Number($('setAllocation').value),
      roundTripCostPct: Number($('setCost').value),
      slippagePct: Number($('setSlippage').value),
      minTradeQuoteVolumeUsdt: Number($('setMinVolume').value),
      binanceBaseUrl: $('setBinanceUrl').value.trim()
    });
    renderSettings();
    note('advancedNote', 'Saved. Takes effect on the next engine check.', 'good');
  } catch (e) { note('advancedNote', e.message, 'bad'); }
});
$('forgetAdminToken').addEventListener('click', () => { saveAdminToken(''); renderAdminTokenState(); });

// --- clock: countdowns and rings, once a second --------------------------------------
function tickClock() {
  const now = Date.now();
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const deadline = Number(el.dataset.deadline);
    if (!deadline) return;
    if (el.classList.contains('ring-fill')) {
      const period = Number(el.dataset.period) || 1;
      const remaining = Math.max(0, deadline - now);
      el.style.strokeDashoffset = String(RING_CIRCUMFERENCE * Math.min(1, remaining / period));
    } else {
      el.textContent = fmtCountdown(deadline - now);
    }
  });
}

async function bootstrap() {
  const [config, settings] = await Promise.all([api('/api/config'), api('/api/settings')]);
  state.config = config;
  state.settings = settings;
  await Promise.all([loadCore(), loadPrices(), loadNotifications(), loadVerdict(), loadAccuracy()]);
  setInterval(loadCore, 20_000);
  setInterval(loadPrices, 30_000);
  setInterval(loadNotifications, 30_000);
  setInterval(loadAccuracy, 5 * 60_000);
  setInterval(tickClock, 1000);
  setInterval(() => { if (state.view === 'coin' && state.coinSymbol) loadChart().catch(console.error); }, 60_000);
}

bootstrap().catch((error) => {
  console.error(error);
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="card" style="border-color:var(--bear);color:var(--bear)">Couldn't load the dashboard: ${escapeHtml(error.message)}</div>`);
});
