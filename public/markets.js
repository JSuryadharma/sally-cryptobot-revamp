'use strict';

// Home (whole account), Saham IDX, stock detail and News views. Loaded before
// app.js; only defines functions here. app.js calls initMarkets() and
// loadMarkets() from its bootstrap, and renderMarketsView() from
// renderCurrentView(). Uses app.js helpers ($, api, escapeHtml, fmtIdr...).

const mk = {
  account: null,
  idx: null,
  news: null,
  insights: null,
  idxFilter: 'all',
  idxSearch: '',
  newsFilter: 'all',
  stockSymbol: null,
  stockCandles: [],
  stockHighlight: null
};

const MK_STAGE_ORDER = { ready: 0, 'setting-up': 1, holding: 2, watching: 3, blocked: 4 };
const MK_COLORS = { cash: '#C9C6BB', crypto: '#1F6FEB', idx: '#C98A10', up: '#1A8F5A', down: '#D1433F', grid: '#EEEDE8', text: '#6B6A64', ema20: '#1F6FEB', ema50: '#9A988F' };

const fmtRp = (n) => (Number.isFinite(n) ? `Rp ${Math.round(n).toLocaleString('id-ID')}` : '-');
const fmtSigned = (n, f = fmtIdrShort) => (Number.isFinite(n) ? `${n >= 0 ? '+' : '-'}${f(Math.abs(n))}` : '-');
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const symLabel = (market, symbol) => (market === 'crypto' ? base(symbol) : symbol);

async function loadMarkets() {
  const [account, idx, news, insights] = await Promise.allSettled([api('/api/account'), api('/api/idx'), api('/api/news?limit=80'), api('/api/insights')]);
  if (account.status === 'fulfilled') mk.account = account.value;
  if (idx.status === 'fulfilled') mk.idx = idx.value;
  if (news.status === 'fulfilled') mk.news = news.value;
  if (insights.status === 'fulfilled') mk.insights = insights.value;
  renderCurrentView();
}

function renderMarketsView(view) {
  if (view === 'home') renderHome();
  else if (view === 'idx') renderIdx();
  else if (view === 'stock') renderStock();
  else if (view === 'news') renderNews();
}

// --- small building blocks -------------------------------------------------------
function sparkSvg(values, { w = 120, h = 36, stroke } = {}) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const color = stroke || (v.at(-1) >= v[0] ? 'var(--bull)' : 'var(--bear)');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" preserveAspectRatio="none"><polyline fill="none" style="stroke:${color}" stroke-width="1.6" stroke-linejoin="round" points="${pts}"/></svg>`;
}

// Time-machine odds (src/tools/timeMachine.js) as a three-part bar.
function oddsHtml(o, { compact = false, prefix = '' } = {}) {
  if (!o || o.pTarget == null) return '';
  const t = Math.round(o.pTarget * 100), s = Math.round(o.pStop * 100), n = Math.max(0, 100 - t - s);
  const cls = /target/.test(o.label) ? 'good' : /stop/.test(o.label) ? 'bad' : '';
  return `<div class="odds" title="${o.paths} replays of past daily candles over ${o.horizonDays} days">
    <div class="odds-bar"><span class="t" style="width:${t}%"></span><span class="s" style="width:${s}%"></span><span class="n" style="width:${n}%"></span></div>
    <div class="odds-text"><span>${prefix}<b class="up">${t}%</b> target first · <b class="down">${s}%</b> stop first${n >= 3 ? ` · ${n}% neither` : ''}</span>
    ${compact ? '' : `<span class="pill ${cls}">${escapeHtml(o.label)}</span>`}</div>
    ${compact ? '' : `<div class="muted small">Of the replays that reached a level, ${Math.round((o.share ?? 0) * 100)}% hit the target first; at ${o.rewardRisk}R break-even is ${Math.round((o.breakEven ?? 0) * 100)}%.${o.avgDaysToExit ? ` Decided in ~${Math.round(o.avgDaysToExit)} days on average.` : ''}</div>`}
  </div>`;
}

function toneDot(sentiment) {
  const label = sentiment?.label || 'neutral';
  return `<span class="tone ${label}" title="Tone: ${label}"></span>`;
}

function tickerChip(t) {
  const r = t.reaction;
  const move = r?.sincePct != null ? ` <span class="${r.sincePct >= 0 ? 'up' : 'down'}">${fmtPct(r.sincePct, 1)}</span>` : '';
  return `<button class="ticker-chip ${t.market}" data-ticker="${t.market}:${t.symbol}" title="Price since the headline">${escapeHtml(symLabel(t.market, t.symbol))}${move}</button>`;
}

function newsItemHtml(n, i = 0) {
  const ago = fmtAgo(Date.now() - Date.parse(n.publishedAt));
  return `<article class="news-item enter" style="--i:${Math.min(i, 10)}">
    ${toneDot(n.sentiment)}
    <div class="news-body">
      <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(n.title)}</a>
      <div class="news-meta"><span>${escapeHtml(n.source || '')} · ${ago}</span>${(n.tickers || []).slice(0, 4).map(tickerChip).join('')}</div>
    </div>
  </article>`;
}

function bindTickerChips(root) {
  root.querySelectorAll('[data-ticker]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const [market, symbol] = el.dataset.ticker.split(':');
    if (market === 'idx') openStock(symbol); else openCoin(symbol);
  }));
}

function oddsFor(market, symbol) {
  return market === 'idx' ? mk.idx?.odds?.[symbol] : mk.insights?.odds?.[symbol];
}

// --- home: the whole account -----------------------------------------------------
function renderHome() {
  const a = mk.account;
  if (!a) { $('homeEquity').textContent = 'Rp -'; return; }
  animateNumber($('homeEquity'), a.equityIdr, fmtIdr);
  $('homeReturn').innerHTML = `<span class="${a.totalReturnPct >= 0 ? 'up' : 'down'}">${fmtPct(a.totalReturnPct)}</span> since the ${fmtIdr(a.initialBalanceIdr)} deposit`;
  const c = a.markets.crypto, s = a.markets.idx;
  const parts = [
    { key: 'cash', label: 'Cash', value: a.cashIdr },
    { key: 'crypto', label: 'Crypto', value: c.marketValueIdr },
    { key: 'idx', label: 'Saham IDX', value: s.marketValueIdr }
  ];
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
  $('allocBar').innerHTML = parts.map((p) => `<span class="seg-${p.key}" style="width:${pctOf(Math.max(0, p.value), total).toFixed(2)}%" title="${p.label} ${fmtIdr(p.value)}"></span>`).join('');
  $('allocLegend').innerHTML = parts.map((p) => `<div><i class="dot-${p.key}"></i><span>${p.label}</span><b>${fmtIdrShort(p.value)}</b><small>${pctOf(Math.max(0, p.value), total).toFixed(0)}%</small></div>`).join('');

  const status = robotStatus();
  const auto = state.status?.autopilot;
  $('homeCrypto').innerHTML = `
    <div class="market-head"><span class="market-badge crypto">Crypto</span><span class="pill ${status.cls === 'ok' ? 'good' : status.cls === 'bad' ? 'bad' : 'warn'}">${escapeHtml(status.title)}</span></div>
    <div class="market-num">${fmtIdrShort(c.marketValueIdr)}<small class="${c.unrealizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(c.unrealizedProfitIdr)} open</small></div>
    <div class="mini-stats"><div><span>Positions</span><b>${c.openPositions}/${state.settings?.maxOpenPositions ?? '-'}</b></div><div><span>Realized</span><b class="${c.realizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(c.realizedProfitIdr)}</b></div><div><span>Strategy</span><b>${escapeHtml(auto?.paused ? 'Paused' : PROFILE_SHORT[auto?.chosen] || '-')}</b></div></div>`;
  const ihsg = mk.idx?.ihsg;
  const idxOn = mk.idx?.enabled;
  $('homeIdx').innerHTML = `
    <div class="market-head"><span class="market-badge idx">Saham IDX</span>${!idxOn ? '<span class="pill">Off</span>' : ihsg ? `<span class="pill ${ihsg.regimeOk ? 'good' : 'warn'}">IHSG ${ihsg.regimeOk ? 'above' : 'below'} 200d</span>` : '<span class="pill">Waiting for data</span>'}</div>
    <div class="market-num">${fmtIdrShort(s.marketValueIdr)}<small class="${s.unrealizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(s.unrealizedProfitIdr)} open</small></div>
    <div class="mini-stats"><div><span>Positions</span><b>${s.openPositions}/${state.settings?.idx?.maxOpenPositions ?? '-'}</b></div><div><span>Realized</span><b class="${s.realizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(s.realizedProfitIdr)}</b></div><div><span>Market</span><b>${mk.idx?.sessionOpen ? 'Open' : 'Closed'}</b></div></div>`;

  const positions = [...c.positions, ...s.positions];
  $('homePositions').innerHTML = positions.length ? positions.map((p, i) => positionCardHtml(p, i)).join('')
    : '<div class="empty">No open positions in either market. The robot buys when a breakout rule is met; the odds of each trade show here.</div>';
  bindPositionCards($('homePositions'));

  const news = (mk.news?.items || []).filter((n) => n.tickers?.length).slice(0, 5);
  $('homeNews').innerHTML = news.length ? news.map(newsItemHtml).join('') : '<div class="empty">No tagged headlines yet. News refreshes every 15 minutes.</div>';
  bindTickerChips($('homeNews'));

  const scans = [...(mk.insights?.scanner || []).map((x) => ({ ...x, market: 'crypto' })), ...(mk.idx?.scanner || []).map((x) => ({ ...x, market: 'idx' }))];
  $('homeScanner').innerHTML = scans.length ? scans.slice(0, 16).map((x) => `<button class="scan-chip ${x.market}" data-ticker="${x.market}:${x.symbol}"><b>${escapeHtml(symLabel(x.market, x.symbol))}</b>${escapeHtml(x.labels.join(', '))}</button>`).join('')
    : '<div class="muted small">No scanner setups on the last daily close.</div>';
  bindTickerChips($('homeScanner'));
}

function positionCardHtml(p, i) {
  const idx = p.market === 'idx';
  const pnl = p.unrealizedProfitIdr ?? 0;
  const risk = p.entryPrice - (p.initialStop ?? p.stopPrice);
  const rNow = risk > 0 && Number.isFinite(p.currentPrice) ? Math.round(((p.currentPrice - p.entryPrice) / risk) * 100) / 100 : null;
  const size = idx ? `${p.quantity / 100} lot` : `${Number(p.quantity.toPrecision(4))} ${base(p.symbol)}`;
  const price = idx ? fmtRp : fmtPrice;
  return `<div class="card position-card enter" style="--i:${i}" data-pos="${p.market}:${p.symbol}">
    <div class="position-head">
      <div class="coin-name"><span class="coin-dot ${p.market}">${escapeHtml(symLabel(p.market, p.symbol).slice(0, 4))}</span><div><b>${escapeHtml(symLabel(p.market, p.symbol))} <span class="market-badge ${p.market} tiny">${idx ? 'IDX' : 'Crypto'}</span></b><small>${size} · entry ${price(p.entryPrice)} · stop ${price(p.stopPrice)}</small></div></div>
      <div class="row-right"><b class="${pnl >= 0 ? 'up' : 'down'}">${fmtSigned(pnl)}</b><span class="muted small">${rNow != null ? `${rNow >= 0 ? '+' : ''}${rNow}R` : fmtPct(p.unrealizedProfitPct ?? 0)}</span></div>
    </div>
    ${oddsHtml(oddsFor(p.market, p.symbol), { compact: true, prefix: 'From here: ' })}
  </div>`;
}

function bindPositionCards(root) {
  root.querySelectorAll('[data-pos]').forEach((el) => el.addEventListener('click', () => {
    const [market, symbol] = el.dataset.pos.split(':');
    if (market === 'idx') openStock(symbol); else openCoin(symbol);
  }));
}

// --- Saham IDX ---------------------------------------------------------------------
function renderIdx() {
  const d = mk.idx;
  const s = mk.account?.markets?.idx;
  if (!d) return;
  const ihsg = d.ihsg;
  $('ihsgCard').innerHTML = !d.enabled
    ? '<div class="eyebrow">IHSG</div><div class="muted">IDX trading is off. Turn it on in Settings.</div>'
    : ihsg ? `
      <div class="ihsg-top"><div><div class="eyebrow">IHSG composite</div><div class="big-number">${Math.round(ihsg.close).toLocaleString('id-ID')}</div>
      <div class="muted small">${ihsg.date} · 200-day avg ${Math.round(ihsg.sma200).toLocaleString('id-ID')} (${fmtPct(ihsg.abovePct, 1)})</div></div>${sparkSvg(ihsg.sparkline, { w: 140, h: 48 })}</div>
      <div class="ihsg-foot"><span class="pill ${ihsg.regimeOk ? 'good' : 'warn'}">${ihsg.regimeOk ? 'Buying allowed: IHSG above its 200-day average' : 'No new buys: IHSG below its 200-day average'}</span><span class="pill">${d.sessionOpen ? 'Market open' : 'Market closed'}</span></div>`
      : '<div class="eyebrow">IHSG</div><div class="muted">Waiting for the first IDX data load (Yahoo Finance).</div>';
  if (s) {
    $('idxBookCard').innerHTML = `<div class="eyebrow">Saham book · shared cash</div>
      <div class="big-number">${fmtIdr(s.marketValueIdr)}</div>
      <div class="muted small">Cash available to both markets: ${fmtIdr(mk.account.cashIdr)}</div>
      <div class="mini-stats"><div><span>Positions</span><b>${s.openPositions}/${state.settings?.idx?.maxOpenPositions ?? '-'}</b></div><div><span>Open P&amp;L</span><b class="${s.unrealizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(s.unrealizedProfitIdr)}</b></div><div><span>Realized</span><b class="${s.realizedProfitIdr >= 0 ? 'up' : 'down'}">${fmtSigned(s.realizedProfitIdr)}</b></div></div>
      <div class="status-chips">${d.autoTrade ? '<span class="pill good">Auto-trade on</span>' : '<span class="pill warn">Watching only</span>'}<span class="pill">Checked ${d.lastRunAt ? fmtAgo(Date.now() - Date.parse(d.lastRunAt)) : 'not yet'}</span>${d.risk?.haltReason ? `<span class="pill bad">${escapeHtml(d.risk.haltReason)}</span>` : ''}</div>`;
  }
  const positions = s?.positions || [];
  $('idxPositions').innerHTML = positions.length ? positions.map((p, i) => positionCardHtml(p, i)).join('') : '<div class="empty">No open stock positions.</div>';
  bindPositionCards($('idxPositions'));

  const q = mk.idxSearch.trim().toUpperCase();
  let stocks = [...(d.stocks || [])].sort((a, b) => (MK_STAGE_ORDER[a.stage] - MK_STAGE_ORDER[b.stage]) || ((a.plan?.distancePct ?? 99) - (b.plan?.distancePct ?? 99)));
  if (q) stocks = stocks.filter((x) => x.symbol.includes(q) || x.name.toUpperCase().includes(q));
  if (mk.idxFilter !== 'all') stocks = stocks.filter((x) => x.stage === mk.idxFilter);
  const newsCount = Object.fromEntries((mk.news?.tickers || []).filter((t) => t.market === 'idx').map((t) => [t.symbol, t]));
  $('idxList').innerHTML = !d.stocks?.length ? '<div class="empty">No stocks loaded yet. They appear after the first IDX check.</div>'
    : !stocks.length ? '<div class="empty">No stocks match this filter.</div>'
      : stocks.map((x, i) => {
        const dist = x.plan?.distancePct;
        const meter = dist == null ? 0 : Math.max(0, Math.min(100, 100 - dist * 10));
        const nc = newsCount[x.symbol];
        return `<div class="row stock-row enter" style="--i:${Math.min(i, 12)}" data-stock="${x.symbol}">
          <div class="coin-name"><span class="coin-dot idx">${x.symbol}</span><div><b>${x.symbol}</b><small>${escapeHtml(x.name)}</small></div></div>
          <div class="row-mid">
            <div class="row-tags"><span class="stage-chip ${x.stage}">${STAGE_LABEL[x.stage]}</span>${x.setups.map((l) => `<span class="pill">${escapeHtml(l)}</span>`).join('')}${nc ? `<span class="pill pill-soft">${nc.count} news</span>` : ''}</div>
            ${x.stage !== 'holding' && dist != null ? `<div class="meter" title="${dist}% from the 20-day high"><span style="width:${meter}%"></span></div>` : ''}
            <div class="muted">${escapeHtml(x.why)}</div>
          </div>
          <div class="row-right"><b>${fmtRp(x.price)}</b><span class="change ${x.changePct >= 0 ? 'up' : 'down'}">${fmtPct(x.changePct ?? 0)}</span>${sparkSvg(x.sparkline, { w: 72, h: 22 })}</div>
        </div>`;
      }).join('');
  $('idxList').querySelectorAll('[data-stock]').forEach((el) => el.addEventListener('click', () => openStock(el.dataset.stock)));

  $('idxScanner').innerHTML = (d.scanner || []).length ? d.scanner.map((x) => `<button class="scan-chip idx" data-ticker="idx:${x.symbol}"><b>${x.symbol}</b>${escapeHtml(x.labels.join(', '))} · RSI ${x.rsi14 ?? '-'}</button>`).join('')
    : '<div class="muted small">No setups on the last daily close.</div>';
  bindTickerChips($('idxScanner'));
  $('idxErrors').textContent = d.errors?.length ? `Couldn't load: ${d.errors.map((e) => e.symbol).join(', ')}.` : '';
}

// --- stock detail --------------------------------------------------------------------
function openStock(symbol) {
  if (symbol !== mk.stockSymbol) { mk.stockCandles = []; mk.stockHighlight = null; }
  mk.stockSymbol = symbol;
  showView('stock');
  loadStockChart().catch((e) => { $('stockChartNote').textContent = e.message; });
}

async function loadStockChart() {
  const res = await api(`/api/idx/${mk.stockSymbol}/candles`);
  mk.stockCandles = res.candles || [];
  $('stockChartNote').textContent = 'Daily candles · tap one to inspect';
  drawStockChart();
}

function stockBySymbol(symbol) { return (mk.idx?.stocks || []).find((s) => s.symbol === symbol) || null; }

function renderStock() {
  const x = stockBySymbol(mk.stockSymbol);
  $('stockSymbol').textContent = mk.stockSymbol || '-';
  $('stockName').textContent = x?.name || '';
  if (!x) { $('stockPlan').innerHTML = '<div class="muted">Not on the IDX watchlist or not loaded yet.</div>'; return; }
  $('stockPrice').textContent = fmtRp(x.price);
  $('stockChange').className = `change ${x.changePct >= 0 ? 'up' : 'down'}`;
  $('stockChange').textContent = fmtPct(x.changePct ?? 0);
  $('stockStage').className = `stage-chip ${x.stage}`;
  $('stockStage').textContent = STAGE_LABEL[x.stage];
  const p = x.plan;
  const held = (mk.account?.markets?.idx?.positions || []).find((q) => q.symbol === x.symbol);
  const odds = held ? oddsFor('idx', x.symbol) : p?.odds;
  $('stockPlan').innerHTML = `
    <p class="plan-sentence">${escapeHtml(x.why)}</p>
    <div class="kv-grid">
      ${held ? `<div class="kv"><span>Entry</span><b>${fmtRp(held.entryPrice)}</b></div><div class="kv"><span>Stop</span><b class="down">${fmtRp(held.stopPrice)}</b></div><div class="kv"><span>Target</span><b class="up">${fmtRp(held.entryPrice + 2 * (held.entryPrice - held.initialStop))}</b></div><div class="kv"><span>Size</span><b>${held.quantity / 100} lot</b></div>`
        : p ? `<div class="kv"><span>Buy above</span><b>${fmtRp(p.level)}</b></div><div class="kv"><span>Planned stop</span><b class="down">${fmtRp(p.stop)}</b></div><div class="kv"><span>Target (+2R)</span><b class="up">${fmtRp(p.target)}</b></div><div class="kv"><span>Distance</span><b>${p.distancePct}%</b></div>` : ''}
      <div class="kv"><span>RSI14</span><b>${x.rsi14 != null ? Math.round(x.rsi14) : '-'}</b></div><div class="kv"><span>ATR</span><b>${x.atrPct != null ? x.atrPct.toFixed(1) : '-'}%</b></div><div class="kv"><span>Daily value</span><b>Rp ${(x.valueIdr / 1e9).toFixed(1)}B</b></div><div class="kv"><span>IHSG filter</span><b class="${x.regimeOk ? 'up' : 'down'}">${x.regimeOk ? 'OK' : 'Blocked'}</b></div>
    </div>
    ${odds ? `<div class="field-label">${held ? 'Odds from here (time machine)' : 'If it breaks out (time machine)'}</div>${oddsHtml(odds)}` : ''}
    ${x.setups.length ? `<div class="row-tags" style="margin-top:10px">${x.setups.map((l) => `<span class="pill">${escapeHtml(l)}</span>`).join('')}</div>` : ''}`;
  const news = (mk.news?.items || []).filter((n) => n.tickers?.some((t) => t.market === 'idx' && t.symbol === x.symbol));
  const agg = (mk.news?.tickers || []).find((t) => t.market === 'idx' && t.symbol === x.symbol);
  $('stockNews').innerHTML = (agg ? `<div class="muted small corr-line">${correlationSentence(agg)}</div>` : '')
    + (news.length ? news.slice(0, 8).map(newsItemHtml).join('') : '<div class="muted small">No headlines about this stock in the last 3 weeks.</div>');
  bindTickerChips($('stockNews'));
  $('stockPosition').textContent = held ? `Holding ${held.quantity / 100} lot since ${fmtClock(Date.parse(held.openedAt))}.` : 'No open position.';
  $('stockSellBtn').disabled = !held;
  $('stockBuyBtn').disabled = Boolean(held) || !mk.idx?.enabled;
  if (mk.stockCandles.length) drawStockChart();
}

function drawStockChart() {
  const tc = themeColors();
  Object.assign(MK_COLORS, { up: tc.up, down: tc.down, grid: tc.grid, text: tc.text, ema20: tc.ema20, ema50: tc.ema50, cross: tc.cross, signal: tc.signal });
  const canvas = $('stockChart');
  const candles = mk.stockCandles;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (!candles.length) return;
  const x0 = stockBySymbol(mk.stockSymbol);
  const held = (mk.account?.markets?.idx?.positions || []).find((q) => q.symbol === mk.stockSymbol);
  const levels = [];
  if (held) {
    levels.push({ price: held.entryPrice, color: MK_COLORS.text, dash: [], label: `Entry ${fmtRp(held.entryPrice)}` });
    levels.push({ price: held.stopPrice, color: MK_COLORS.down, dash: [6, 4], label: `Stop ${fmtRp(held.stopPrice)}`, below: true });
  } else if (x0?.plan) {
    levels.push({ price: x0.plan.level, color: MK_COLORS.signal, dash: [6, 4], label: `20-day high ${fmtRp(x0.plan.level)}` });
  }
  ctx.font = '600 11px Inter, sans-serif';
  const pad = { l: 8, r: Math.ceil(ctx.measureText(fmtRp(Math.max(...candles.map((c) => c.high)))).width) + 14, t: 12, b: 22 };
  let min = Math.min(...candles.map((c) => c.low)), max = Math.max(...candles.map((c) => c.high));
  for (const l of levels) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
  const span = (max - min) || max * 0.01;
  min -= span * 0.04; max += span * 0.04;
  const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
  const x = (i) => pad.l + (candles.length === 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
  const y = (p) => pad.t + (1 - (p - min) / (max - min)) * plotH;
  const step = plotW / Math.max(1, candles.length - 1);
  ctx.strokeStyle = MK_COLORS.grid; ctx.lineWidth = 1; ctx.fillStyle = MK_COLORS.text; ctx.font = '11px Inter, sans-serif';
  for (let k = 0; k <= 4; k += 1) {
    const p = min + ((max - min) * k) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(w - pad.r, y(p)); ctx.stroke();
    ctx.fillText(Math.round(p).toLocaleString('id-ID'), w - pad.r + 6, y(p) + 4);
  }
  const bodyW = Math.max(1, Math.min(step * 0.62, 10));
  candles.forEach((c, i) => {
    const col = c.close >= c.open ? MK_COLORS.up : MK_COLORS.down;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - bodyW / 2, top, bodyW, Math.max(1, y(Math.min(c.open, c.close)) - top));
  });
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    candles.forEach((c, i) => {
      if (!Number.isFinite(c[key])) { started = false; return; }
      if (!started) { ctx.moveTo(x(i), y(c[key])); started = true; } else ctx.lineTo(x(i), y(c[key]));
    });
    ctx.stroke();
  };
  line('ema50', MK_COLORS.ema50);
  line('ema20', MK_COLORS.ema20);
  for (const l of levels) {
    ctx.strokeStyle = l.color; ctx.setLineDash(l.dash); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y(l.price)); ctx.lineTo(w - pad.r, y(l.price)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = l.color; ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText(l.label, pad.l + 4, y(l.price) + (l.below ? 14 : -5));
  }
  ctx.fillStyle = MK_COLORS.text; ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'left'; ctx.fillText(candles[0].date, pad.l, h - 6);
  ctx.textAlign = 'right'; ctx.fillText(candles.at(-1).date, w - pad.r, h - 6);
  ctx.textAlign = 'left';
  if (mk.stockHighlight != null && candles[mk.stockHighlight]) {
    ctx.strokeStyle = MK_COLORS.cross; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(mk.stockHighlight), pad.t); ctx.lineTo(x(mk.stockHighlight), pad.t + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }
  $('stockLegend').innerHTML = `<span><i style="border-color:${MK_COLORS.ema20}"></i>EMA20</span><span><i style="border-color:${MK_COLORS.ema50}"></i>EMA50</span>${levels.map((l) => `<span><i class="${l.dash.length ? 'dash' : ''}" style="border-color:${l.color}"></i>${escapeHtml(l.label.split(' Rp')[0])}</span>`).join('')}`;
}

async function stockTrade(action) {
  const symbol = mk.stockSymbol;
  const btn = action === 'BUY' ? $('stockBuyBtn') : $('stockSellBtn');
  btn.disabled = true;
  try {
    await api(`/api/idx/${symbol}/trade`, { method: 'POST', body: { action } });
    toast(`${action === 'BUY' ? 'Bought' : 'Sold'} ${symbol}`, 'Paper trade done on the shared cash.');
    await Promise.all([loadMarkets(), loadCore()]);
  } catch (error) {
    toast(`${action} failed`, error.message);
  } finally {
    renderStock();
  }
}

// --- news ------------------------------------------------------------------------------
function correlationSentence(t) {
  const tone = t.avgTone > 0.15 ? 'mostly positive' : t.avgTone < -0.15 ? 'mostly negative' : 'mixed';
  const match = t.toneMatchedMovePct != null ? ` Tone matched the next-day move ${t.toneMatchedMovePct}% of the time (${t.measured} measured${t.toneMoveCorrelation != null ? `, correlation ${t.toneMoveCorrelation >= 0 ? '+' : ''}${t.toneMoveCorrelation}` : ''}).` : ' Not enough closes after the headlines yet to measure the reaction.';
  return `<b>${escapeHtml(symLabel(t.market, t.symbol))}</b>: ${t.count} headline${t.count === 1 ? '' : 's'} in 14 days, ${tone} (${t.bullish} up, ${t.bearish} down).${match}`;
}

function renderNews() {
  const d = mk.news;
  if (!d) { $('newsList').innerHTML = '<div class="skeleton-card"></div>'; return; }
  const f = mk.newsFilter;
  const items = (d.items || []).filter((n) => f === 'all' || n.market === f || n.tickers?.some((t) => t.market === f));
  const tickers = (d.tickers || []).filter((t) => f === 'all' || t.market === f).slice(0, 12);
  $('newsUpdated').textContent = d.updatedAt ? `Updated ${fmtAgo(Date.now() - Date.parse(d.updatedAt))}. Sources: Google News, CNBC Indonesia, CoinDesk, Cointelegraph.` : 'Fetching the first headlines on the next engine check.';
  $('newsTickers').innerHTML = tickers.length ? tickers.map((t) => {
    const w = Math.round(Math.abs(t.avgTone) * 50);
    const matched = t.toneMatchedMovePct;
    return `<button class="corr-row" data-ticker="${t.market}:${t.symbol}">
      <span class="corr-sym"><b>${escapeHtml(symLabel(t.market, t.symbol))}</b><span class="market-badge ${t.market} tiny">${t.market === 'idx' ? 'IDX' : 'Crypto'}</span></span>
      <span class="corr-count">${t.count}<small>news</small></span>
      <span class="tone-bar" title="Average tone ${t.avgTone}"><span class="${t.avgTone >= 0 ? 'pos' : 'neg'}" style="width:${w}%;${t.avgTone >= 0 ? 'left:50%' : `left:${50 - w}%`}"></span></span>
      <span class="corr-match">${matched != null ? `<b class="${matched >= 50 ? 'up' : 'down'}">${matched}%</b><small>n=${t.measured}</small>` : '<small>measuring</small>'}</span>
      <span class="corr-move ${t.priceSinceLatestNewsPct >= 0 ? 'up' : 'down'}">${t.priceSinceLatestNewsPct != null ? fmtPct(t.priceSinceLatestNewsPct, 1) : '-'}</span>
    </button>`;
  }).join('') : '<div class="muted small">No ticker has headlines yet.</div>';
  bindTickerChips($('newsTickers'));
  $('newsList').innerHTML = items.length ? items.slice(0, 60).map(newsItemHtml).join('') : '<div class="empty">No headlines for this filter.</div>';
  bindTickerChips($('newsList'));
}

// --- settings: IDX card -------------------------------------------------------------------
function renderIdxSettings() {
  const s = state.settings?.idx;
  if (!s) return;
  $('idxEnabledToggle').checked = s.enabled;
  $('idxAutoToggle').checked = s.autoTrade;
  $('idxMaxPositions').value = s.maxOpenPositions;
  $('idxWatchlist').innerHTML = s.watchlist.map((sym) => `<span class="tag">${sym}<button data-idx-remove="${sym}" aria-label="Remove ${sym}">&times;</button></span>`).join('');
  $('idxWatchlist').querySelectorAll('[data-idx-remove]').forEach((b) => b.addEventListener('click', async () => {
    try { await saveSettings({ idx: { watchlist: s.watchlist.filter((x) => x !== b.dataset.idxRemove) } }); renderIdxSettings(); note('idxNote', 'Removed.', 'good'); }
    catch (e) { note('idxNote', e.message, 'bad'); }
  }));
}

function initMarkets() {
  document.querySelectorAll('#idxFilter .chip').forEach((chip) => chip.addEventListener('click', () => {
    mk.idxFilter = chip.dataset.stage;
    document.querySelectorAll('#idxFilter .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderIdx();
  }));
  $('idxSearch').addEventListener('input', (e) => { mk.idxSearch = e.target.value; renderIdx(); });
  document.querySelectorAll('#newsFilter .chip').forEach((chip) => chip.addEventListener('click', () => {
    mk.newsFilter = chip.dataset.market;
    document.querySelectorAll('#newsFilter .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderNews();
  }));
  $('stockBack').addEventListener('click', () => showView('idx'));
  $('stockBuyBtn').addEventListener('click', () => stockTrade('BUY'));
  $('stockSellBtn').addEventListener('click', () => stockTrade('SELL'));
  $('stockChart').addEventListener('click', (event) => {
    const candles = mk.stockCandles;
    if (!candles.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(candles.length - 1, Math.round(((event.clientX - rect.left - 8) / Math.max(1, rect.width - 80)) * (candles.length - 1))));
    mk.stockHighlight = i;
    const c = candles[i];
    $('stockChartNote').textContent = `${c.date}: O ${fmtRp(c.open)} H ${fmtRp(c.high)} L ${fmtRp(c.low)} C ${fmtRp(c.close)}`;
    drawStockChart();
  });
  window.addEventListener('resize', () => { if (state.view === 'stock') drawStockChart(); });
  const saveIdx = async (patch, msg) => {
    try { await saveSettings({ idx: patch }); renderIdxSettings(); note('idxNote', msg, 'good'); loadMarkets(); }
    catch (e) { note('idxNote', e.message, 'bad'); renderIdxSettings(); }
  };
  $('idxEnabledToggle').addEventListener('change', (e) => saveIdx({ enabled: e.target.checked }, e.target.checked ? 'IDX stocks are on.' : 'IDX stocks are off. Open stock positions stay until you sell them.'));
  $('idxAutoToggle').addEventListener('change', (e) => saveIdx({ autoTrade: e.target.checked }, e.target.checked ? 'The robot buys stocks automatically.' : 'The robot only watches stocks.'));
  $('idxSave').addEventListener('click', () => saveIdx({ maxOpenPositions: Number($('idxMaxPositions').value) }, 'Saved.'));
  $('idxAddBtn').addEventListener('click', () => {
    const sym = $('idxAddInput').value.trim().toUpperCase().replace(/\.JK$/, '');
    if (!/^[A-Z]{4}$/.test(sym)) { note('idxNote', 'Enter a 4-letter IDX code, like BBCA.', 'bad'); return; }
    if (state.settings.idx.watchlist.includes(sym)) { note('idxNote', `${sym} is already on the list.`); return; }
    $('idxAddInput').value = '';
    saveIdx({ watchlist: [...state.settings.idx.watchlist, sym] }, `${sym} added. It appears after the next IDX check.`);
  });
}
