const state = {
  view: 'home',
  coinSymbol: null,
  chartMode: null, // which timeframe the chart is showing right now - independent of the coin's trading mode until the user picks one
  chartCandles: [],
  chartHighlight: null,
  chartStructure: null,
  config: null,
  coins: [],
  portfolio: null,
  notifications: [],
  movers: [],
  settings: null,
  lastDetail: null,
  backtestVerdict: null
};

const MODES = ['swing', 'scalping', 'dayTrade'];
// Chart timeframe switcher shows one extra option ('4h') that isn't one of
// the three trading modes above - it's chart-only, see marketData.js.
const CHART_TIMEFRAMES = ['scalping', 'dayTrade', '4h', 'swing'];
const INTERVAL_LABEL = { swing: '1D', scalping: '15m', dayTrade: '1h', '4h': '4H' };
const KLINE_DURATION_LABEL = { swing: '1 candle = 1 day', scalping: '1 candle = 15 minutes', dayTrade: '1 candle = 1 hour', '4h': '1 candle = 4 hours' };
const TIMEFRAME_TITLE = { swing: 'Swing (1D)', scalping: 'Scalping (15m)', dayTrade: 'Day-trade (1h)', '4h': '4-hour chart' };
// Which EMA pair the chart overlays per timeframe - matches STRATEGY_PARAMS
// in decisionEngine.js for the three trading modes; '4h' isn't a trading
// mode (chart-only) so it reuses the 9/21 pair as the closest fit.
const CHART_EMA_KEYS = {
  swing: { fast: 'ema20', slow: 'ema50' },
  scalping: { fast: 'ema9', slow: 'ema21' },
  dayTrade: { fast: 'ema9', slow: 'ema21' },
  '4h': { fast: 'ema9', slow: 'ema21' }
};

const $ = (id) => document.getElementById(id);
const fmtIdr = (n) => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
const fmtPct = (n) => (n >= 0 ? '+' : '') + (n ?? 0).toFixed(2) + '%';
const fmtUsd = (n) => '$' + Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 4 : 2 });

async function api(path, opts) {
  const res = await fetch(path, opts && { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}

// --- navigation --------------------------------------------------------
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  $(`view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
}

document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => { showView(btn.dataset.view); refreshCurrentView(); }));
$('backButton').addEventListener('click', () => { showView('market'); refreshCurrentView(); });

function openCoin(symbol) {
  if (symbol !== state.coinSymbol) state.chartMode = null; // reset timeframe choice when switching coins
  state.coinSymbol = symbol;
  showView('coin');
  loadCoinDetail(symbol);
}

// --- HOME ---------------------------------------------------------------
async function loadHome() {
  const [portfolio, notifs, verdict] = await Promise.all([api('/api/portfolio'), api('/api/notifications'), api('/api/backtest-verdict')]);
  state.portfolio = portfolio;
  state.notifications = notifs.items || [];
  state.backtestVerdict = verdict;
  renderHome();
}

function renderHome() {
  const p = state.portfolio;
  if (!p) return;
  $('headerBalance').textContent = fmtIdr(p.equityIdr ?? p.balanceIdr);
  $('equityValue').textContent = fmtIdr(p.equityIdr ?? p.balanceIdr);
  const retEl = $('returnValue');
  const ret = p.totalReturnPct ?? 0;
  retEl.textContent = `${fmtPct(ret)} since start`;
  retEl.className = 'sub ' + (ret >= 0 ? 'up' : 'down');
  $('cashValue').textContent = fmtIdr(p.balanceIdr);
  const positionsValue = (p.equityIdr ?? p.balanceIdr) - p.balanceIdr;
  $('positionsValue').textContent = fmtIdr(positionsValue);
  $('realizedValue').textContent = fmtIdr(p.realizedProfitIdr || 0);

  const positions = Object.values(p.positions || {});
  const list = $('positionsList');
  list.innerHTML = '';
  if (!positions.length) {
    list.innerHTML = '<div class="empty-hint">No open positions - the robot is watching for a fresh entry signal.</div>';
  } else {
    for (const pos of positions) {
      const row = document.createElement('div');
      row.className = 'row-item';
      const pnl = pos.unrealizedProfitPct ?? 0;
      row.innerHTML = `
        <div class="row-left">
          <div class="coin-dot">${pos.symbol.replace('USDT', '').slice(0, 3)}</div>
          <div><div class="row-symbol">${pos.symbol}</div><div class="row-sub">${modeLabel(pos.mode)} · entry ${fmtUsd(pos.entryPrice)}</div></div>
        </div>
        <div class="row-right">
          <div class="row-price">${fmtIdr(pos.marketValueIdr ?? pos.investedIdr)}</div>
          <div class="row-change ${pnl >= 0 ? 'up' : 'down'}" style="color:${pnl >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">${fmtPct(pnl)}</div>
        </div>`;
      row.addEventListener('click', () => openCoin(pos.symbol));
      list.appendChild(row);
    }
  }

  renderBacktestVerdict();

  const notifList = $('notificationsList');
  notifList.innerHTML = '';
  if (!state.notifications.length) {
    notifList.innerHTML = '<div class="empty-hint">No notifications yet.</div>';
  } else {
    for (const n of state.notifications.slice(0, 12)) {
      const div = document.createElement('div');
      div.className = 'notif-item';
      div.innerHTML = `<div class="notif-title ${n.level}">${escapeHtml(n.title)}</div><div>${escapeHtml(n.message)}</div><div class="notif-meta">${new Date(n.createdAt).toLocaleString()}</div>`;
      notifList.appendChild(div);
    }
  }
}

function modeLabel(mode) {
  return { swing: 'Swing', scalping: 'Scalping', dayTrade: 'Day-trade' }[mode] || mode;
}

// Animates an element's displayed number from whatever it last showed (tracked
// via a data attribute, since the DOM text itself may carry a suffix like
// "/100") up/down to `target` - an ease-out rolling-odometer effect rather
// than the score just popping into place.
function animateRollingNumber(el, target, { suffix = '', duration = 800 } = {}) {
  const start = Number(el.dataset.rollValue) || 0;
  el.dataset.rollValue = String(target);
  if (start === target) { el.textContent = `${target}${suffix}`; return; }
  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(start + (target - start) * eased);
    el.textContent = `${value}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Last .claude/skills/backtest-expert verdict, read via /api/backtest-verdict -
// so "auto-trade is on" is never shown without "and here's whether the last
// backtest actually cleared Deploy" right next to it. This never triggers a
// backtest itself - it only reads whatever evaluate_backtest.mjs last wrote.
const VERDICT_BADGE_CLASS = { Deploy: 'badge-bullish', Refine: 'badge-neutral', Abandon: 'badge-bearish' };
function renderBacktestVerdict() {
  const v = state.backtestVerdict;
  const badge = $('verdictBadge');
  const scoreEl = $('verdictScore');
  const metaEl = $('verdictMeta');
  if (!v || !v.available) {
    badge.className = 'badge badge-neutral';
    badge.textContent = 'N/A';
    scoreEl.textContent = 'No backtest run yet';
    scoreEl.dataset.rollValue = '0';
    metaEl.innerHTML = 'Run <code>node scripts/benchmark.mjs</code> then the <code>backtest-expert</code> skill\'s <code>evaluate_backtest.mjs --summary</code> to populate this.';
    return;
  }
  badge.className = 'badge ' + (VERDICT_BADGE_CLASS[v.verdict] || 'badge-neutral');
  badge.textContent = v.verdict || '-';
  animateRollingNumber(scoreEl, v.totalScore, { suffix: '/100' });
  const when = v.generatedAtIso ? new Date(v.generatedAtIso).toLocaleString() : 'unknown time';
  const flagCount = (v.redFlags || []).length;
  const flagNote = flagCount ? `${flagCount} red flag${flagCount === 1 ? '' : 's'}: ${v.redFlags.map((f) => f.message).join(' ')}` : 'No red flags.';
  const s = v.benchmarkSummary;
  const summaryNote = s ? ` · ${s.months}mo, ${s.closedTrades} trades, ${fmtPct(s.totalReturnPct)} return, win ${s.winRate ?? 'n/a'}%` : '';
  metaEl.textContent = `As of ${when}${summaryNote} - ${flagNote}`;
}

// --- run a backtest from the app itself (POST /api/backtest/run) -----------
let backtestMonths = 1;
document.querySelectorAll('#backtestMonthsRow .view-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#backtestMonthsRow .view-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
    backtestMonths = Number(btn.dataset.months);
  });
});

$('runBacktestBtn').addEventListener('click', async () => {
  const btn = $('runBacktestBtn');
  const hint = $('backtestRunHint');
  const card = $('backtestCard');
  btn.disabled = true;
  btn.textContent = 'Running...';
  hint.style.display = 'block';
  card.classList.remove('is-success', 'is-error');
  card.classList.add('is-running');
  try {
    state.backtestVerdict = await api('/api/backtest/run', { method: 'POST', body: { months: backtestMonths } });
    renderBacktestVerdict();
    card.classList.remove('is-running');
    card.classList.add('is-success');
  } catch (error) {
    $('verdictMeta').textContent = `Backtest run failed: ${error.message}`;
    card.classList.remove('is-running');
    card.classList.add('is-error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run backtest now';
    hint.style.display = 'none';
  }
});

// --- MARKET ---------------------------------------------------------------
async function loadMarket() {
  // allSettled, not all: a Binance ticker hiccup on /api/movers should never
  // blank out the watchlist half of this tab, which comes from /api/coins.
  const [coinsResult, moversResult] = await Promise.allSettled([api('/api/coins'), api('/api/movers')]);
  state.coins = coinsResult.status === 'fulfilled' ? coinsResult.value.coins || [] : [];
  state.movers = moversResult.status === 'fulfilled' ? moversResult.value.movers || [] : [];
  state.moversError = moversResult.status === 'fulfilled' ? moversResult.value.error : moversResult.reason?.message;
  renderMarket();
}

function badgeClass(label) {
  if (label === 'Bullish') return 'badge-bullish';
  if (label === 'Bearish') return 'badge-bearish';
  return 'badge-neutral';
}

function renderMarket() {
  const list = $('watchlistList');
  list.innerHTML = '';
  const query = ($('marketSearch').value || '').trim().toUpperCase();
  const visibleCoins = query ? state.coins.filter((c) => c.symbol.includes(query)) : state.coins;
  if (!state.coins.length) list.innerHTML = '<div class="empty-hint">Loading watchlist...</div>';
  else if (!visibleCoins.length) list.innerHTML = `<div class="empty-hint">No watchlist coin matches "${escapeHtml(query)}".</div>`;
  for (const coin of visibleCoins) {
    list.appendChild(coinRow(coin.symbol, coin.latest?.close, coin.latest?.changePct, coin.summary?.label, coin.activeMode, coin.entryOrExit?.confidencePct, coin.sparkline));
  }

  const movers = $('moversList');
  movers.innerHTML = '';
  if (state.moversError) {
    movers.innerHTML = `<div class="empty-hint">Top movers unavailable: ${escapeHtml(state.moversError)}</div>`;
  } else if (!state.movers.length) {
    movers.innerHTML = '<div class="empty-hint">Loading top movers...</div>';
  }
  for (const m of state.movers) {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = `
      <div class="row-left"><div class="coin-dot">${m.symbol.replace('USDT', '').slice(0, 3)}</div><div><div class="row-symbol">${m.symbol}</div><div class="row-sub">Vol ${fmtUsd(m.quoteVolume)}</div></div></div>
      <div class="row-right"><div class="row-price">${fmtUsd(m.price)}</div><div class="row-change" style="color:${m.changePct >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">${fmtPct(m.changePct)}</div></div>`;
    row.addEventListener('click', () => addToWatchlistAndOpen(m.symbol));
    movers.appendChild(row);
  }
}

function coinRow(symbol, price, changePct, label, mode, confidencePct, sparkline) {
  const row = document.createElement('div');
  row.className = 'row-item';
  row.innerHTML = `
    <div class="row-left"><div class="coin-dot">${symbol.replace('USDT', '').slice(0, 3)}</div>
      <div><div class="row-symbol">${symbol}</div><div class="row-sub">${mode ? modeLabel(mode) : ''}</div></div></div>
    <div class="row-mid"><canvas class="row-spark" width="60" height="28"></canvas></div>
    <div class="row-right">
      <div class="row-price">${price != null ? fmtUsd(price) : '-'}</div>
      <div class="row-change" style="color:${(changePct ?? 0) >= 0 ? 'var(--bullish)' : 'var(--bearish)'}">${changePct != null ? fmtPct(changePct) : ''}</div>
      <div style="margin-top:4px; display:flex; gap:4px; justify-content:flex-end;">
        ${label ? `<span class="badge ${badgeClass(label)}">${label}</span>` : ''}
        ${confidencePct != null ? `<span class="badge-confidence">${confidencePct}%</span>` : ''}
      </div>
    </div>`;
  row.addEventListener('click', () => openCoin(symbol));
  drawMiniSpark(row.querySelector('.row-spark'), sparkline);
  return row;
}

async function addToWatchlistAndOpen(symbol) {
  if (!state.settings.watchlist.includes(symbol)) {
    const next = { ...state.settings, watchlist: [...state.settings.watchlist, symbol] };
    state.settings = await api('/api/settings', { method: 'POST', body: { watchlist: next.watchlist } });
  }
  openCoin(symbol);
}

$('refreshMovers').addEventListener('click', loadMarket);
$('marketSearch').addEventListener('input', renderMarket);

$('refreshAllBtn').addEventListener('click', async () => {
  const btn = $('refreshAllBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('active');
  try {
    await api('/api/coins/refresh-all', { method: 'POST' });
    await loadMarket();
  } catch (error) {
    console.error('refresh-all failed:', error);
  } finally {
    btn.disabled = false;
    btn.classList.remove('active');
  }
});

document.querySelectorAll('#view-market .view-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-market .view-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const showMovers = btn.dataset.list === 'movers';
    $('watchlistSection').classList.toggle('hidden', showMovers);
    $('moversSection').classList.toggle('hidden', !showMovers);
  });
});

// --- COIN DETAIL ---------------------------------------------------------------
async function loadCoinDetail(symbol) {
  $('coinSymbol').textContent = symbol;
  const detail = await api(`/api/coins/${symbol}`);
  state.lastDetail = detail;
  if (!state.chartMode) state.chartMode = detail.activeMode;
  renderCoinDetail(detail);
  await loadChart(symbol, state.chartMode);
}

async function loadChart(symbol, mode) {
  const candlesRes = await api(`/api/coins/${symbol}/candles?mode=${mode}`);
  state.chartCandles = candlesRes.candles;
  state.chartHighlight = null;
  state.chartStructure = candlesRes.structure;
  renderTimeframeRow();
  $('chartInterval').textContent = `${INTERVAL_LABEL[mode]} · ${KLINE_DURATION_LABEL[mode]} · ${state.chartCandles.length} candles`;
  $('chartDetail').textContent = 'Tap a candle for its price and date';
  drawChart(state.chartCandles, null);
  drawMiniSpark($('coinSpark'), state.chartCandles.slice(-30).map((c) => c.close));
  renderStructure(candlesRes.structure);
}

function renderTimeframeRow() {
  const row = $('timeframeRow');
  row.innerHTML = '';
  for (const mode of CHART_TIMEFRAMES) {
    const btn = document.createElement('button');
    btn.className = 'timeframe-btn' + (mode === state.chartMode ? ' active' : '');
    btn.textContent = INTERVAL_LABEL[mode];
    btn.title = TIMEFRAME_TITLE[mode] || modeLabel(mode);
    btn.addEventListener('click', () => {
      state.chartMode = mode;
      loadChart(state.coinSymbol, mode).catch(console.error);
    });
    row.appendChild(btn);
  }
}

// --- signal significance: BOS / CHoCH + nearest support/resistance ---------
function renderStructure(structure) {
  const badge = $('structureBadge');
  const levelEl = $('structureLevel');
  const noteEl = $('structureNote');
  const sig = structure?.signal;
  if (!sig || sig.type === 'None') {
    badge.className = 'structure-badge none';
    badge.textContent = sig ? 'No fresh break' : 'Not enough history';
    levelEl.textContent = '';
  } else {
    badge.className = `structure-badge ${sig.type.toLowerCase()}-${sig.direction}`;
    badge.textContent = `${sig.type} · ${sig.direction}`;
    levelEl.textContent = sig.level != null ? `at ${fmtUsd(sig.level)}` : '';
  }
  noteEl.textContent = sig?.description || 'Not enough swing history on this timeframe yet to read structure.';

  const grid = $('srGrid');
  grid.innerHTML = '';
  grid.appendChild(srColumn('Support', structure?.supportResistance?.support || []));
  grid.appendChild(srColumn('Resistance', structure?.supportResistance?.resistance || []));
}

function srColumn(title, levels) {
  const col = document.createElement('div');
  const rows = levels.length
    ? levels.map((l) => `<div class="sr-level"><span>${fmtUsd(l.price)}</span><span>${l.touches}&times;</span></div>`).join('')
    : '<div class="sr-level"><span>-</span><span></span></div>';
  col.innerHTML = `<div class="sr-col-title">${title}</div>${rows}`;
  return col;
}

// --- strategy parameters (the active mode's actual numbers) ----------------
function renderParams(p) {
  const grid = $('paramGrid');
  grid.innerHTML = '';
  if (!p) { grid.innerHTML = '<div class="empty-hint">-</div>'; return; }
  const cells = [
    ['EMA cross', p.emaCrossLabel],
    ['RSI filter', `${p.rsiLabel} ${p.rsiRangeLabel}`],
    ['Trailing stop', `${p.slAtrMult}&times; ATR below the highest price since entry`],
    ['Take-profit', `${p.tpAtrMult}&times; ATR`],
    ['Max hold', p.holdLabel]
  ];
  for (const [label, val] of cells) {
    const cell = document.createElement('div');
    cell.className = 'indicator-cell';
    cell.innerHTML = `<div class="label">${label}</div><div class="value">${val}</div>`;
    grid.appendChild(cell);
  }
}

// --- "how close to a trade?" - the gap between now and an actual BUY/SELL --
function renderNearCondition(near) {
  const noteEl = $('nearConditionNote');
  const grid = $('nearConditionGrid');
  grid.innerHTML = '';
  if (!near) { noteEl.textContent = 'Not enough data yet.'; return; }
  noteEl.textContent = near.note;
  const cells = near.kind === 'exit'
    ? [
        ['Distance to stop', near.distanceToStopPct != null ? `${near.distanceToStopPct}%` : '-'],
        ['Distance to target', near.distanceToTargetPct != null ? `${near.distanceToTargetPct}%` : '-']
      ]
    : [
        ['EMA gap', near.emaGapPct != null ? `${near.emaGapPct >= 0 ? '+' : ''}${near.emaGapPct}%` : '-'],
        ['RSI vs. band', near.rsiValue != null ? near.rsiValue.toFixed(1) : '-'],
        ['ADX vs. floor', near.adxValue != null ? near.adxValue.toFixed(1) : '-']
      ];
  for (const [label, val] of cells) {
    const cell = document.createElement('div');
    cell.className = 'indicator-cell';
    cell.innerHTML = `<div class="label">${label}</div><div class="value">${val}</div>`;
    grid.appendChild(cell);
  }
}

function renderCoinDetail(detail) {
  const latest = detail.latest || {};
  $('coinPrice').textContent = fmtUsd(latest.close);
  const changeEl = $('coinChange');
  const changeAbs = latest.change != null ? `${latest.change >= 0 ? '+' : ''}${fmtUsd(latest.change)} ` : '';
  changeEl.textContent = `${changeAbs}(${fmtPct(latest.changePct || 0)})`;
  changeEl.className = 'coin-change ' + ((latest.changePct || 0) >= 0 ? 'up' : 'down');

  const inWatchlist = (state.settings?.watchlist || []).includes(detail.symbol);
  $('watchlistStar').classList.toggle('active', inWatchlist);

  const gaugePct = detail.summary?.gaugePct ?? 50;
  $('gaugeMarker').style.left = gaugePct + '%';
  $('summaryText').textContent = detail.summary?.text || '-';

  const confidencePct = detail.entryOrExit?.confidencePct ?? 0;
  const ring = $('confidenceRing');
  ring.className = 'confidence-ring ' + (confidencePct >= 70 ? 'high' : confidencePct >= 40 ? 'mid' : 'low');
  $('confidenceValue').textContent = `${confidencePct}%`;
  const minConf = detail.minConfidencePct ?? state.settings?.autoTrade?.minConfidencePct;
  const action = detail.entryOrExit?.action || 'HOLD';
  const executed = detail.entryOrExit?.executed;
  let note;
  if (action === 'BUY' && executed === false) note = `Signal seen but below your ${minConf}% threshold - not executed.`;
  else if (action === 'BUY' && executed) note = `Executed - confidence cleared your ${minConf}% threshold.`;
  else if (action === 'SELL') note = 'Exits always execute regardless of confidence (risk management overrides).';
  else note = `Your auto-trade threshold is ${minConf}%.`;
  $('confidenceNote').textContent = note;

  const modeRow = $('modeRow');
  modeRow.innerHTML = '';
  for (const m of MODES) {
    const chip = document.createElement('div');
    chip.className = 'mode-chip' + (m === detail.activeMode ? ' active' : '');
    chip.textContent = modeLabel(m);
    modeRow.appendChild(chip);
  }
  $('modeReason').textContent = detail.modeOverride
    ? `Pinned to ${modeLabel(detail.modeOverride)} in Settings - overriding the regime pick (which would otherwise be: ${detail.recommendation?.reason || 'n/a'})`
    : (detail.recommendation?.reason || '-');
  renderParams(detail.strategyParams);
  renderNearCondition(detail.nearCondition);
  renderFetchInfo(detail.modes, detail.activeMode);

  const grid = $('indicatorGrid');
  grid.innerHTML = '';
  const cells = [
    ['EMA fast', numOrDash(latest.ema9 ?? latest.ema20)],
    ['EMA slow', numOrDash(latest.ema21 ?? latest.ema50)],
    ['RSI', numOrDash(latest.rsi14 ?? latest.rsi7)],
    ['ADX (trend strength)', numOrDash(latest.adx14)],
    ['ATR %', numOrDash(latest.atrPct)],
    ['Confidence', `${confidencePct}%`]
  ];
  for (const [label, val] of cells) {
    const cell = document.createElement('div');
    cell.className = 'indicator-cell';
    cell.innerHTML = `<div class="label">${label}</div><div class="value">${val}</div>`;
    grid.appendChild(cell);
  }

  const posEl = $('positionDetail');
  const buyBtn = $('buyBtn');
  const sellBtn = $('sellBtn');
  const openPosition = (state.portfolio?.positions || {})[detail.symbol];
  if (openPosition) {
    posEl.textContent = `Holding since ${new Date(openPosition.openedAt).toLocaleString()} · entry ${fmtUsd(openPosition.entryPrice)} · trailing stop ${fmtUsd(openPosition.stopPrice)} (high since entry ${fmtUsd(openPosition.highWaterMark ?? openPosition.entryPrice)}) · target ${fmtUsd(openPosition.targetPrice)}`;
    buyBtn.disabled = true;
    sellBtn.disabled = false;
  } else {
    posEl.textContent = detail.entryOrExit?.reason || 'No open position.';
    buyBtn.disabled = false;
    sellBtn.disabled = true;
  }
}

function numOrDash(v) { return v != null ? Number(v).toFixed(2) : '-'; }

$('watchlistStar').addEventListener('click', async () => {
  const symbol = state.coinSymbol;
  const inWatchlist = (state.settings?.watchlist || []).includes(symbol);
  const next = inWatchlist ? state.settings.watchlist.filter((s) => s !== symbol) : [...state.settings.watchlist, symbol];
  state.settings = await api('/api/settings', { method: 'POST', body: { watchlist: next } });
  $('watchlistStar').classList.toggle('active', !inWatchlist);
});

$('buyBtn').addEventListener('click', async () => {
  if (!confirm(`Simulate a paper BUY on ${state.coinSymbol}?`)) return;
  await api(`/api/coins/${state.coinSymbol}/trade`, { method: 'POST', body: { action: 'BUY' } });
  await Promise.all([loadHome(), loadCoinDetail(state.coinSymbol)]);
});
$('sellBtn').addEventListener('click', async () => {
  if (!confirm(`Simulate a paper SELL on ${state.coinSymbol}?`)) return;
  await api(`/api/coins/${state.coinSymbol}/trade`, { method: 'POST', body: { action: 'SELL' } });
  await Promise.all([loadHome(), loadCoinDetail(state.coinSymbol)]);
});

// --- chart: price/date axis labels + click-to-inspect -----------------------
function chartX(i, count, w) {
  return count > 1 ? (i / (count - 1)) * (w - 10) + 5 : w / 2;
}

// Finds the candle whose time is closest to a given unix-seconds timestamp -
// used to place a structure pivot (from analyzeStructure, computed over more
// history than the trimmed ~120 visible candles) at the right x position.
function indexForTime(candles, time) {
  let closest = 0, closestDist = Infinity;
  candles.forEach((c, i) => {
    const dist = Math.abs(c.time - time);
    if (dist < closestDist) { closestDist = dist; closest = i; }
  });
  return closest;
}

// Every bar where the fast EMA crossed the slow one, in either direction -
// this is a chart-reading aid only (marks history so a whipsaw-prone coin is
// visibly obvious), separate from decisionEngine.js's own fresh-cross check
// which only cares about the single latest bar.
function findEmaCrosses(candles, fastKey, slowKey) {
  const crosses = [];
  for (let i = 1; i < candles.length; i += 1) {
    const fPrev = candles[i - 1][fastKey], sPrev = candles[i - 1][slowKey];
    const fNow = candles[i][fastKey], sNow = candles[i][slowKey];
    if (![fPrev, sPrev, fNow, sNow].every(Number.isFinite)) continue;
    if (fPrev <= sPrev && fNow > sNow) crosses.push({ index: i, direction: 'bullish' });
    else if (fPrev >= sPrev && fNow < sNow) crosses.push({ index: i, direction: 'bearish' });
  }
  return crosses;
}

function drawChart(candles, highlightIndex) {
  const canvas = $('coinChart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!candles.length) return;

  const structure = state.chartStructure;
  const emaKeys = CHART_EMA_KEYS[state.chartMode] || CHART_EMA_KEYS.swing;

  // Trend structure: connect the last two same-direction swing pivots -
  // swing LOWS in an uptrend (higher lows), swing HIGHS in a downtrend
  // (lower highs). Skipped entirely when the trend reads as range/undefined,
  // or there aren't two matching pivots yet.
  let trendPoints = null;
  if (structure?.trend === 'uptrend' && (structure.swingLows || []).length >= 2) {
    trendPoints = structure.swingLows.slice(-2);
  } else if (structure?.trend === 'downtrend' && (structure.swingHighs || []).length >= 2) {
    trendPoints = structure.swingHighs.slice(-2);
  }

  // The current (rightmost) candle's ATR14 volatility band - close +/- one
  // ATR, the same envelope decisionEngine.js's own stop/target math is
  // derived from. Shown as a standalone reference regardless of any open
  // position or pending signal - see server.js's /candles route for atr14.
  const lastCandle = candles.at(-1);
  const atrBand = Number.isFinite(lastCandle?.atr14) && lastCandle.atr14 > 0
    ? { high: lastCandle.close + lastCandle.atr14, low: Math.max(0, lastCandle.close - lastCandle.atr14), value: lastCandle.atr14 }
    : null;

  // Buy-point prediction: the armed EMA/BB-retest level from the live
  // combined-entry strategy (triggerVariants.js, via liveStrategy.js),
  // surfaced on /api/coins/:symbol as entryOrExit.armedLevel whenever this
  // coin isn't currently held and a retest is waiting to confirm. Absent
  // entirely (not just null) on an exit-shaped result, so this doubles as
  // the "not currently holding" check.
  const detail = state.lastDetail;
  const predicted = detail?.symbol === state.coinSymbol ? detail.entryOrExit : null;
  const armedLevel = Number.isFinite(predicted?.armedLevel) ? predicted.armedLevel : null;

  // Y-range comes from the visible candles' own high/low (not just close,
  // so wicks and the trendline both fit) widened just enough to include the
  // trendline's own two points, the ATR band, and a pending buy-point level
  // if any of those fall outside the plain candle range. Support/resistance/
  // structure levels that still fall outside this are skipped below rather
  // than distorting the whole chart to fit a level that's long since aged
  // out of the visible window.
  const highs = candles.map((c) => c.high ?? c.close);
  const lows = candles.map((c) => c.low ?? c.close);
  let min = Math.min(...lows), max = Math.max(...highs);
  if (trendPoints) {
    for (const p of trendPoints) { min = Math.min(min, p.price); max = Math.max(max, p.price); }
  }
  if (atrBand) { min = Math.min(min, atrBand.low); max = Math.max(max, atrBand.high); }
  if (armedLevel != null) { min = Math.min(min, armedLevel); max = Math.max(max, armedLevel); }
  const range = (max - min) || 1;
  const yFor = (price) => h - 24 - ((price - min) / range) * (h - 40);

  const closes = candles.map((c) => c.close);
  const last = closes.at(-1), first = closes[0];
  const lineColor = last >= first ? '#34d399' : '#f0596a';
  const legendItems = [];

  // --- support / resistance zones (subtle, drawn first so everything else layers on top) ---
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  const support = (structure?.supportResistance?.support || []).filter((l) => l.price >= min && l.price <= max);
  const resistance = (structure?.supportResistance?.resistance || []).filter((l) => l.price >= min && l.price <= max);
  ctx.strokeStyle = 'rgba(52,211,153,0.4)';
  for (const lvl of support) { const y = yFor(lvl.price); ctx.beginPath(); ctx.moveTo(5, y); ctx.lineTo(w - 5, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(240,89,106,0.4)';
  for (const lvl of resistance) { const y = yFor(lvl.price); ctx.beginPath(); ctx.moveTo(5, y); ctx.lineTo(w - 5, y); ctx.stroke(); }
  if (support.length) legendItems.push({ label: 'Support', kind: 'dashed', color: 'rgba(52,211,153,0.8)' });
  if (resistance.length) legendItems.push({ label: 'Resistance', kind: 'dashed', color: 'rgba(240,89,106,0.8)' });
  ctx.setLineDash([]);

  // --- BOS / CHoCH: a labeled level line at the broken swing point ---------
  const sig = structure?.signal;
  if (sig && sig.type !== 'None' && Number.isFinite(sig.level) && sig.level >= min && sig.level <= max) {
    const y = yFor(sig.level);
    const color = sig.direction === 'bullish' ? '#34d399' : '#f0596a';
    ctx.setLineDash(sig.type === 'CHoCH' ? [2, 3] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(5, y); ctx.lineTo(w - 5, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(sig.type, 8, y - 3);
    legendItems.push({ label: `${sig.type} · ${sig.direction}`, kind: sig.type === 'CHoCH' ? 'dashed' : 'line', color });
  }

  // --- trendline -------------------------------------------------------------
  if (trendPoints) {
    const [p0, p1] = trendPoints;
    const x0 = chartX(indexForTime(candles, p0.time), candles.length, w);
    const x1 = chartX(indexForTime(candles, p1.time), candles.length, w);
    ctx.setLineDash([1, 3]);
    ctx.strokeStyle = 'rgba(143,217,168,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, yFor(p0.price)); ctx.lineTo(x1, yFor(p1.price)); ctx.stroke();
    ctx.setLineDash([]);
    legendItems.push({ label: `Trendline (${structure.trend})`, kind: 'dotted', color: 'rgba(143,217,168,0.9)' });
  }

  // --- ATR annotation: the current candle's volatility band ------------------
  // Drawn as two reference lines (high/low) tied together with a bracket at
  // the current candle, so it reads as "this candle's range, not just its
  // close" rather than a generic horizontal level.
  const ATR_COLOR = '#b389f0';
  if (atrBand) {
    const yHigh = yFor(atrBand.high);
    const yLow = yFor(atrBand.low);
    const xLast = chartX(candles.length - 1, candles.length, w);
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = ATR_COLOR;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(5, yHigh); ctx.lineTo(w - 5, yHigh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, yLow); ctx.lineTo(w - 5, yLow); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xLast, yHigh); ctx.lineTo(xLast, yLow); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = ATR_COLOR;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`ATR high ${fmtUsd(atrBand.high)}`, 8, Math.max(10, yHigh - 3));
    ctx.fillText(`ATR low ${fmtUsd(atrBand.low)}`, 8, Math.min(h - 30, yLow + 11));
    legendItems.push({ label: `ATR14 band (±${fmtUsd(atrBand.value)})`, kind: 'dotted', color: ATR_COLOR });
  }

  // --- buy-point prediction: the armed retest level, if any ------------------
  const BUY_POINT_COLOR = '#ffd166';
  if (armedLevel != null) {
    const y = yFor(armedLevel);
    const blocked = Boolean(predicted.directionBlocked);
    ctx.setLineDash(blocked ? [1, 4] : [5, 3]);
    ctx.strokeStyle = BUY_POINT_COLOR;
    ctx.globalAlpha = blocked ? 0.5 : 0.9;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(5, y); ctx.lineTo(w - 5, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = BUY_POINT_COLOR;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    const kindLabel = predicted.triggerKind === 'bb' ? 'BB retest' : 'EMA retest';
    const waitLabel = Number.isFinite(predicted.barsWaited) && Number.isFinite(predicted.windowBars) ? ` ${predicted.barsWaited}/${predicted.windowBars}` : '';
    ctx.fillText(`Buy trigger ~${fmtUsd(armedLevel)} (${kindLabel}${waitLabel}${blocked ? ' · direction-blocked' : ''})`, w - 6, Math.max(20, y - 3));
    legendItems.push({ label: `Buy-point prediction${blocked ? ' (blocked)' : ''}`, kind: blocked ? 'dotted' : 'dashed', color: BUY_POINT_COLOR });
  }

  // --- candlesticks (kline) - the primary series, replaces the old close-price line ---
  const count = candles.length;
  const spacing = count > 1 ? (w - 10) / (count - 1) : w;
  const bodyWidth = Math.max(1, Math.min(spacing * 0.62, 9));
  const wickWidth = Math.max(1, Math.min(spacing * 0.18, 2));
  candles.forEach((c, i) => {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) return;
    const x = chartX(i, count, w);
    const bullish = c.close >= c.open;
    const color = bullish ? '#34d399' : '#f0596a';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = wickWidth;
    ctx.beginPath();
    ctx.moveTo(x, yFor(c.high));
    ctx.lineTo(x, yFor(c.low));
    ctx.stroke();
    const yOpen = yFor(c.open), yClose = yFor(c.close);
    const top = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, bodyH);
  });

  // --- EMA fast/slow overlay + every fresh-cross bar marked -----------------
  const FAST_COLOR = '#f5a623', SLOW_COLOR = '#7c93e8';
  const hasEma = candles.some((c) => Number.isFinite(c[emaKeys.fast]) && Number.isFinite(c[emaKeys.slow]));
  if (hasEma) {
    const drawEma = (key, color) => {
      let started = false;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      candles.forEach((c, i) => {
        const v = c[key];
        if (!Number.isFinite(v)) { started = false; return; }
        const x = chartX(i, candles.length, w);
        const y = yFor(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    };
    drawEma(emaKeys.slow, SLOW_COLOR);
    drawEma(emaKeys.fast, FAST_COLOR);
    legendItems.push({ label: `EMA ${emaKeys.fast.replace('ema', '')} (fast)`, kind: 'line', color: FAST_COLOR });
    legendItems.push({ label: `EMA ${emaKeys.slow.replace('ema', '')} (slow)`, kind: 'line', color: SLOW_COLOR });

    const crosses = findEmaCrosses(candles, emaKeys.fast, emaKeys.slow);
    for (const cross of crosses) {
      const c = candles[cross.index];
      const x = chartX(cross.index, candles.length, w);
      const y = yFor(c[emaKeys.fast]);
      ctx.fillStyle = cross.direction === 'bullish' ? '#34d399' : '#f0596a';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    if (crosses.length) legendItems.push({ label: 'EMA cross', kind: 'dot', color: '#8fd9a8' });
  }

  // --- price axis labels (max/min) and date axis labels (first/last candle) ---
  ctx.fillStyle = '#98a396';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(fmtUsd(max), w - 6, 12);
  ctx.fillText(fmtUsd(min), w - 6, h - 28);
  ctx.textAlign = 'left';
  ctx.fillText(shortDate(candles[0]), 6, h - 8);
  ctx.textAlign = 'right';
  ctx.fillText(shortDate(candles.at(-1)), w - 6, h - 8);

  if (highlightIndex != null && candles[highlightIndex]) {
    const c = candles[highlightIndex];
    const x = chartX(highlightIndex, candles.length, w);
    const y = yFor(c.close);
    ctx.strokeStyle = 'rgba(242,244,238,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 24); ctx.stroke();
    ctx.save();
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#f2f4ee';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  renderChartLegend(legendItems);
}

// DOM legend for the overlays above - built as HTML (not drawn on canvas) so
// labels stay crisp and items simply don't appear when that overlay has
// nothing to show right now (e.g. no support level currently in range).
function renderChartLegend(items) {
  const el = $('chartLegend');
  if (!el) return;
  el.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'chart-legend-item';
    const swatch = document.createElement('span');
    if (item.kind === 'dot') {
      swatch.className = 'chart-legend-dot';
      swatch.style.background = item.color;
    } else {
      swatch.className = 'chart-legend-swatch' + (item.kind === 'dashed' ? ' dashed' : item.kind === 'dotted' ? ' dotted' : '');
      if (item.kind === 'line') swatch.style.background = item.color;
      else swatch.style.borderColor = item.color;
    }
    row.appendChild(swatch);
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    el.appendChild(row);
  }
}

function shortDate(candle) {
  if (!candle) return '';
  const d = new Date(candle.time * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

$('coinChart').addEventListener('click', (event) => {
  const candles = state.chartCandles;
  if (!candles.length) return;
  const canvas = $('coinChart');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const clickX = (event.clientX - rect.left) * scaleX;
  let closest = 0;
  let closestDist = Infinity;
  candles.forEach((c, i) => {
    const x = chartX(i, candles.length, canvas.width);
    const dist = Math.abs(x - clickX);
    if (dist < closestDist) { closestDist = dist; closest = i; }
  });
  state.chartHighlight = closest;
  drawChart(candles, closest);
  const c = candles[closest];
  const d = new Date(c.time * 1000);
  const dateStr = state.chartMode === 'swing'
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('chartDetail').textContent = `${dateStr} · O ${fmtUsd(c.open)} H ${fmtUsd(c.high)} L ${fmtUsd(c.low)} C ${fmtUsd(c.close)}${Number.isFinite(c.atr14) ? ` · ATR ${fmtUsd(c.atr14)}` : ''}`;
});

// Generic mini line chart for any canvas + array of raw close prices - used
// for both the coin-detail header spark and the small per-row sparklines in
// Market's watchlist list (real recent-closes data from /api/coins, not
// fabricated - see the `sparkline` field robotEngine.js now sends).
function drawMiniSpark(canvas, values) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const up = values.at(-1) >= values[0];
  ctx.strokeStyle = up ? '#34d399' : '#f0596a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// --- SETTINGS ---------------------------------------------------------------
async function loadSettings() {
  state.settings = await api('/api/settings');
  state.config = await api('/api/config');
  renderSettings();
}

function renderSettings() {
  const s = state.settings;
  $('autoTradeToggle').checked = !!s.autoTrade.enabled;
  $('telegramToggle').checked = !!s.telegram.enabled;
  $('telegramStatus').textContent = s.telegram.configured ? 'Telegram is configured.' : 'Telegram bot token / chat ID not set yet.';

  $('confidenceThreshold').value = s.autoTrade.minConfidencePct;
  $('confidenceThresholdValue').textContent = `${s.autoTrade.minConfidencePct}%`;

  const rrList = $('rrTemplateList');
  rrList.innerHTML = '';
  const templates = s.riskRewardTemplates || {};
  for (const [key, tpl] of Object.entries(templates)) {
    const card = document.createElement('div');
    card.className = 'rr-card' + (key === s.autoTrade.riskRewardTemplate ? ' active' : '');
    card.innerHTML = `<div class="rr-card-title"><span>${tpl.label}</span><span>1 : ${tpl.ratio}</span></div><div class="rr-card-desc">${escapeHtml(tpl.description)}</div>`;
    card.addEventListener('click', async () => {
      state.settings = await api('/api/settings', { method: 'POST', body: { autoTrade: { riskRewardTemplate: key } } });
      renderSettings();
    });
    rrList.appendChild(card);
  }

  const modeList = $('modeOverrideList');
  modeList.innerHTML = '';
  const modeOptions = [['', { label: 'Auto (pick per-coin by trend strength)' }], ...Object.entries(s.strategyModes || {})];
  for (const [key, mode] of modeOptions) {
    const active = (s.autoTrade.modeOverride || '') === key;
    const card = document.createElement('div');
    card.className = 'rr-card' + (active ? ' active' : '');
    card.innerHTML = `<div class="rr-card-title"><span>${mode.label}</span></div>`;
    card.addEventListener('click', async () => {
      state.settings = await api('/api/settings', { method: 'POST', body: { autoTrade: { modeOverride: key || null } } });
      renderSettings();
    });
    modeList.appendChild(card);
  }

  const list = $('settingsWatchlist');
  list.innerHTML = '';
  for (const symbol of s.watchlist) {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = `<div class="row-symbol">${symbol}</div><button class="btn-ghost" data-symbol="${symbol}">Remove</button>`;
    row.querySelector('button').addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = s.watchlist.filter((x) => x !== symbol);
      state.settings = await api('/api/settings', { method: 'POST', body: { watchlist: next } });
      renderSettings();
      loadMarket();
    });
    list.appendChild(row);
  }

  // --- AI advisor ---
  document.querySelectorAll('#aiModeToggle .view-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.ai.mode));
  $('aiOpenaiFields').style.display = s.ai.mode === 'openai' ? 'block' : 'none';
  $('aiBaseUrl').value = s.ai.openaiBaseUrl || '';
  const modelSelect = $('aiModel');
  modelSelect.innerHTML = '';
  for (const m of s.ai.availableModels || [s.ai.model]) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === s.ai.model) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  $('aiApiKey').value = ''; // never pre-filled - write-only, same convention as the Telegram token field
  $('aiStatus').textContent = s.ai.mode === 'openai'
    ? (s.ai.configured ? 'OpenAI advisor is active.' : 'OpenAI mode selected, but no API key saved yet - falling back to local summaries.')
    : 'Using local rule-based summaries (no API key needed).';

  // --- trading parameters ---
  $('paramInitialBalance').value = s.initialBalanceIdr;
  $('paramUsdIdr').value = s.usdIdrRate;
  const cfg = state.config;
  const liveNote = $('usdIdrLiveNote');
  if (liveNote && cfg) {
    liveNote.textContent = cfg.usdIdrIsLive
      ? `Live rate from Binance (USDT/IDR): Rp ${Math.round(cfg.usdIdrRate).toLocaleString('id-ID')} - the value above is only the fallback, used if the live fetch ever fails.`
      : `Live fetch unavailable right now - using the fallback rate above (Rp ${Math.round(cfg.usdIdrRate).toLocaleString('id-ID')}).`;
  }
  $('paramAllocationPct').value = s.tradeAllocationPct;
  $('paramMaxPositions').value = s.maxOpenPositions;
  $('paramRoundTripCost').value = s.roundTripCostPct;
  $('paramBinanceBaseUrl').value = s.binanceBaseUrl;
}

$('autoTradeToggle').addEventListener('change', async (e) => {
  state.settings = await api('/api/settings', { method: 'POST', body: { autoTrade: { enabled: e.target.checked } } });
});
$('confidenceThreshold').addEventListener('input', (e) => {
  $('confidenceThresholdValue').textContent = `${e.target.value}%`; // live label while dragging
});
$('confidenceThreshold').addEventListener('change', async (e) => {
  state.settings = await api('/api/settings', { method: 'POST', body: { autoTrade: { minConfidencePct: Number(e.target.value) } } });
});
$('telegramToggle').addEventListener('change', async (e) => {
  state.settings = await api('/api/settings', { method: 'POST', body: { telegram: { enabled: e.target.checked } } });
});
$('saveTelegram').addEventListener('click', async () => {
  const botToken = $('telegramToken').value.trim();
  const chatId = $('telegramChat').value.trim();
  state.settings = await api('/api/settings', { method: 'POST', body: { telegram: { botToken, chatId } } });
  renderSettings();
});
$('testTelegram').addEventListener('click', async () => {
  try {
    await api('/api/telegram/test', { method: 'POST' });
    $('telegramStatus').textContent = 'Test message sent - check Telegram.';
  } catch (error) {
    $('telegramStatus').textContent = 'Failed: ' + error.message;
  }
});
$('addSymbolBtn').addEventListener('click', async () => {
  const raw = $('addSymbolInput').value.trim().toUpperCase();
  if (!raw) return;
  const symbol = raw.endsWith('USDT') ? raw : raw + 'USDT';
  state.settings = await api('/api/settings', { method: 'POST', body: { watchlist: [...new Set([...state.settings.watchlist, symbol])] } });
  $('addSymbolInput').value = '';
  renderSettings();
  loadMarket();
});

document.querySelectorAll('#aiModeToggle .view-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    state.settings = await api('/api/settings', { method: 'POST', body: { ai: { mode: btn.dataset.mode } } });
    renderSettings();
  });
});
$('saveAi').addEventListener('click', async () => {
  const body = { ai: { openaiBaseUrl: $('aiBaseUrl').value.trim(), model: $('aiModel').value } };
  const apiKey = $('aiApiKey').value.trim();
  if (apiKey) body.ai.openaiApiKey = apiKey; // blank means "don't touch the saved key" - same rule as Telegram's token field
  state.settings = await api('/api/settings', { method: 'POST', body });
  renderSettings();
});
$('saveParams').addEventListener('click', async () => {
  state.settings = await api('/api/settings', {
    method: 'POST',
    body: {
      initialBalanceIdr: Number($('paramInitialBalance').value),
      usdIdrRate: Number($('paramUsdIdr').value),
      tradeAllocationPct: Number($('paramAllocationPct').value),
      maxOpenPositions: Number($('paramMaxPositions').value),
      roundTripCostPct: Number($('paramRoundTripCost').value),
      binanceBaseUrl: $('paramBinanceBaseUrl').value.trim()
    }
  });
  renderSettings();
});

// --- per-coin data freshness (replaces the old global DB pulse) ------------
// The DB-connected indicator answered "is Postgres up" - true almost all the
// time, and not the question someone actually has when a coin's numbers look
// off: "is THIS coin's data still live, or did its refresh quietly stop
// working?" fetchedAt already rides along on every /api/coins/:SYMBOL
// response (see robotEngine.js's lightSnapshot) per timeframe, so this reads
// straight off that instead of a separate poll.
// TTLs mirror marketData.js's own CACHE_TTL_MS - kept here only for the
// "does this look stale" color cue, not to duplicate the real cache logic.
const FETCH_TTL_MS = { swing: 10 * 60_000, scalping: 2 * 60_000, dayTrade: 5 * 60_000 };

function formatRelativeTime(iso) {
  if (!iso) return 'never fetched';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderFetchInfo(modes, activeMode) {
  const grid = $('fetchInfoGrid');
  const note = $('fetchInfoNote');
  grid.innerHTML = '';
  note.textContent = "When each timeframe's candles were last pulled from Binance - the active mode (highlighted red only if it's running well past its own refresh cadence) is what your entry/exit decisions are actually running on right now.";
  for (const mode of MODES) {
    const m = modes?.[mode];
    const fetchedAt = m?.fetchedAt;
    const ageMs = fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : null;
    const stale = ageMs != null && ageMs > (FETCH_TTL_MS[mode] ?? 5 * 60_000) * 2;
    const cell = document.createElement('div');
    cell.className = 'indicator-cell';
    cell.innerHTML = `<div class="label">${modeLabel(mode)}${mode === activeMode ? ' (active)' : ''}</div><div class="value${stale ? ' bearish' : ''}">${formatRelativeTime(fetchedAt)}</div>`;
    grid.appendChild(cell);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- polling ---------------------------------------------------------------
function refreshCurrentView() {
  if (state.view === 'home') loadHome().catch(console.error);
  else if (state.view === 'market') loadMarket().catch(console.error);
  else if (state.view === 'coin' && state.coinSymbol) loadCoinDetail(state.coinSymbol).catch(console.error);
  else if (state.view === 'settings') loadSettings().catch(console.error);
}

// Automatic version of the "Refresh All" button (see refreshAllBtn's click
// handler above) - the dashboard used to depend entirely on an external
// trigger for a real data refresh: either someone clicking that button, or
// the GitHub Actions cron (.github/workflows/trading-loop.yml) hitting this
// same POST /api/coins/refresh-all roughly every 5 minutes. That's fine for
// keeping the paper-trading robot alive with nobody watching, but it means
// up to 5 minutes of visibly stale data for anyone who actually has the tab
// open. This loop closes that gap: every 30s, force a real watchlist
// refresh from the browser itself, then re-render whatever's on screen.
// refresh-all's own in-flight guard (see refreshWatchlist.js's
// forceRefreshNow) makes this safe to run alongside the cron and the manual
// button without racing a second concurrent pass over the portfolio.
const AUTO_REFRESH_ALL_MS = 30000;
async function autoRefreshAllLoop() {
  try {
    await api('/api/coins/refresh-all', { method: 'POST' });
  } catch (error) {
    console.error('[autoRefreshAllLoop] refresh-all failed:', error);
  }
  refreshCurrentView();
}

async function bootstrap() {
  state.config = await api('/api/config');
  state.settings = await api('/api/settings');
  await Promise.all([loadHome(), loadMarket()]);
  setInterval(refreshCurrentView, 8000);
  setInterval(autoRefreshAllLoop, AUTO_REFRESH_ALL_MS);
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;color:#f0596a">Failed to load: ${escapeHtml(error.message)}</div>`);
});
