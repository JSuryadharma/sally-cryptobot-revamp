import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { WebSocketHub } from './websocket.js';
import { NotificationCenter } from './notifications.js';
import { readSettings, updateSettings, publicSettings } from './settings.js';
import { getPortfolio, markToMarket, openPosition, closePosition } from './tradingRobot.js';
import { refreshSymbol, portfolioCfg } from './robotEngine.js';
import { loadSnapshot } from './marketData.js';
import { planManualEntry, RR_TEMPLATES } from './decisionEngine.js';
import { fetchTopMovers, fetchTickersFor, resolveUsdIdrRate } from './binanceData.js';
import { sendTelegramMessage, getTelegramStatus } from './notifications.js';
import { analyzeStructure } from './marketStructure.js';
import { readJson } from './storage.js';
import { runAndStoreBacktest, VERDICT_KEY } from './backtestRunner.js';
import { refreshIfStale, readCoinsCache, forceRefreshNow } from './refreshWatchlist.js';
import { checkConnection } from './pgClient.js';

const notifications = new NotificationCenter();
const latestBySymbol = new Map(); // symbol -> last refreshSymbol() result
// '4h' is chart-only (see marketData.js) - not one of the three trading modes.
const CHART_TIMEFRAMES = ['swing', 'scalping', 'dayTrade', '4h'];

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[server] unhandled error:', error);
    sendJson(res, 500, { error: error.message || 'Internal error' });
  });
});

const hub = new WebSocketHub(server);
notifications.setBroadcast((message) => hub.broadcast(message));

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    const db = await checkConnection();
    return sendJson(res, db.connected ? 200 : 503, { database: db });
  }

  if (pathname === '/api/config' && method === 'GET') {
    const settings = await readSettings();
    const usdIdrRate = await resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl);
    return sendJson(res, 200, {
      initialBalanceIdr: settings.initialBalanceIdr,
      usdIdrRate,
      usdIdrFallbackRate: settings.usdIdrRate,
      usdIdrIsLive: usdIdrRate !== settings.usdIdrRate,
      tradeAllocationPct: settings.tradeAllocationPct,
      maxOpenPositions: settings.maxOpenPositions,
      roundTripCostPct: settings.roundTripCostPct,
      timeZone: settings.timeZone
    });
  }

  if (pathname === '/api/coins' && method === 'GET') {
    const settings = await readSettings();
    // The in-memory Map is fast on a persistent host (Railway/Render/a VPS/
    // local), but on a serverless host (Vercel) it starts empty on every
    // invocation - the 24/7 tick() loop below has no persistent process to
    // keep running on. refreshIfStale reads the shared cache and, if it's
    // older than STALE_AFTER_MS (2 minutes), refreshes it inline before
    // returning - the real mechanism this app relies on for freshness now,
    // since Vercel Hobby's cron cap (once/day) can't do it alone. Concurrent
    // requests de-dupe into one shared refresh (see refreshWatchlist.js).
    const { coins: sharedCache } = await refreshIfStale(settings.watchlist);
    const results = settings.watchlist.map((symbol) => latestBySymbol.get(symbol) || sharedCache[symbol]).filter(Boolean);
    return sendJson(res, 200, { coins: results, watchlist: settings.watchlist });
  }

  if (pathname === '/api/coins/refresh-all' && method === 'POST') {
    // Manual, on-demand version of api/cron/refresh.js's job - exists because
    // Vercel Cron's frequency is plan-gated (Hobby caps actual runs to once a
    // day no matter the configured schedule), so this button works
    // regardless of plan/cron timing. Takes ~15-30s for a full watchlist.
    try {
      // forceRefreshNow shares its in-flight guard with refreshIfStale (see
      // refreshWatchlist.js) - if the dashboard's own automatic poll, the
      // GitHub Actions cron, and a manual click all land close together,
      // they join the one run in progress instead of racing separate
      // refreshAll() passes against the same portfolio.
      const { cache, errors } = await forceRefreshNow(undefined);
      for (const [symbol, result] of Object.entries(cache)) latestBySymbol.set(symbol, result);
      return sendJson(res, 200, { refreshedCount: Object.keys(cache).length, errors });
    } catch (error) {
      console.error('[api/coins/refresh-all] failed:', error);
      return sendJson(res, 500, { error: error.message || 'Refresh failed.' });
    }
  }

  const coinMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)$/i);
  if (coinMatch && method === 'GET') {
    const symbol = coinMatch[1].toUpperCase();
    let result = latestBySymbol.get(symbol);
    if (!result) {
      const { coins: sharedCache } = await readCoinsCache();
      result = sharedCache[symbol];
    }
    if (!result) result = await refreshOne(symbol);
    return sendJson(res, 200, result);
  }

  const refreshMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/refresh$/i);
  if (refreshMatch && method === 'POST') {
    const symbol = refreshMatch[1].toUpperCase();
    const result = await refreshOne(symbol, { force: true });
    return sendJson(res, 200, result);
  }

  const tradeMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/trade$/i);
  if (tradeMatch && method === 'POST') {
    const symbol = tradeMatch[1].toUpperCase();
    const body = await readBody(req);
    const action = String(body.action || '').toUpperCase();
    const cached = latestBySymbol.get(symbol);
    if (!cached) return sendJson(res, 400, { error: 'Coin has not loaded yet - try again in a moment.' });

    const settings = await readSettings();
    const cfg = await portfolioCfg(settings);
    if (action === 'BUY') {
      const mode = cached.activeMode;
      const rrMultiple = RR_TEMPLATES[settings.autoTrade.riskRewardTemplate]?.ratio ?? RR_TEMPLATES.balanced.ratio;
      // planManualEntry needs the *enriched* current candle, which lightSnapshot kept as `latest`.
      const plan = planManualEntry(cached.modes[mode]?.latest ? [cached.modes[mode].latest] : [cached.latest], mode, { rrMultiple });
      const result = await openPosition({
        symbol, mode,
        entryPrice: plan.entryPrice, stopPrice: plan.stopPrice, targetPrice: plan.targetPrice,
        maxHoldUntil: plan.maxHoldUntil, reason: plan.reason
      }, cfg);
      if (result.transaction) {
        await notifications.notify({ title: `Manual BUY ${symbol}`, message: `Bought at ${plan.entryPrice}.`, level: 'info', category: 'trade' });
      }
      await refreshOne(symbol, { force: true });
      return sendJson(res, 200, result);
    }
    if (action === 'SELL') {
      const portfolio = await getPortfolio(cfg);
      const position = portfolio.positions[symbol];
      if (!position) return sendJson(res, 400, { error: 'No open position to sell.' });
      const price = cached.latest?.close ?? position.entryPrice;
      const result = await closePosition({ symbol, exitPrice: price, reason: 'Manual sell - user override.' }, cfg);
      if (result.transaction) {
        const pnl = Math.round(result.transaction.realizedProfitIdr).toLocaleString('id-ID');
        await notifications.notify({ title: `Manual SELL ${symbol}`, message: `Sold at ${price}. P&L: Rp ${pnl}.`, level: result.transaction.realizedProfitIdr >= 0 ? 'success' : 'warning', category: 'trade' });
      }
      await refreshOne(symbol, { force: true });
      return sendJson(res, 200, result);
    }
    return sendJson(res, 400, { error: 'action must be BUY or SELL.' });
  }

  const candlesMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/candles$/i);
  if (candlesMatch && method === 'GET') {
    const symbol = candlesMatch[1].toUpperCase();
    const mode = CHART_TIMEFRAMES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'swing';
    const snapshot = await loadSnapshot(symbol, mode);
    // EMA fields are included (not just OHLCV) so the chart can draw the
    // fast/slow EMA lines and mark fresh crosses itself, instead of just
    // plotting close price - see CHART_EMA_KEYS in app.js for which pair
    // applies to which timeframe.
    const trimmed = snapshot.candles.slice(-120).map((c) => ({
      time: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      ema9: c.ema9, ema20: c.ema20, ema21: c.ema21, ema50: c.ema50
    }));
    // Structure (swing pivots -> BOS/CHoCH + support/resistance) is read off
    // whichever timeframe the chart is showing right now, not the trading mode.
    const structure = analyzeStructure(snapshot.candles);
    return sendJson(res, 200, { symbol, mode, interval: snapshot.interval, candles: trimmed, structure });
  }

  if (pathname === '/api/movers' && method === 'GET') {
    // Never let a Binance ticker hiccup take down the whole Market tab - report
    // the reason in-line instead of a bare 500, so the rest of the page (which
    // doesn't depend on this endpoint) keeps working.
    try {
      const settings = await readSettings();
      const movers = await fetchTopMovers({ limit: settings.topMoversCount, minQuoteVolumeUsdt: settings.minQuoteVolumeUsdt, baseUrl: settings.binanceBaseUrl });
      return sendJson(res, 200, { movers });
    } catch (error) {
      console.warn('[api/movers] failed:', error.message);
      return sendJson(res, 200, { movers: [], error: error.message });
    }
  }

  if (pathname === '/api/backtest-verdict' && method === 'GET') {
    return sendJson(res, 200, await loadLatestBacktestVerdict());
  }

  if (pathname === '/api/backtest/run' && method === 'POST') {
    const body = await readBody(req);
    const settings = await readSettings();
    try {
      // months defaults to 1 - fast enough (~15-20s for the full watchlist)
      // to run synchronously within one request; longer windows belong to
      // scripts/benchmark.mjs on your own machine, not this in-app trigger,
      // and would risk a timeout on a serverless host's function duration limit.
      const payload = await runAndStoreBacktest({
        symbols: body.symbols || settings.watchlist,
        months: body.months || 1,
        minConfidencePct: body.minConfidencePct ?? settings.autoTrade.minConfidencePct,
        riskRewardTemplate: body.riskRewardTemplate || settings.autoTrade.riskRewardTemplate,
        baseUrl: settings.binanceBaseUrl,
        initialBalanceIdr: settings.initialBalanceIdr, usdIdrRate: settings.usdIdrRate,
        tradeAllocationPct: settings.tradeAllocationPct, maxOpenPositions: settings.maxOpenPositions,
        roundTripCostPct: settings.roundTripCostPct
      });
      return sendJson(res, 200, payload);
    } catch (error) {
      console.error('[api/backtest/run] failed:', error);
      return sendJson(res, 500, { error: error.message || 'Backtest run failed.' });
    }
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    const settings = await readSettings();
    const cfg = await portfolioCfg(settings);
    const portfolio = await getPortfolio(cfg);
    const prices = {};
    for (const symbol of Object.keys(portfolio.positions)) {
      prices[symbol] = latestBySymbol.get(symbol)?.latest?.close;
    }
    return sendJson(res, 200, markToMarket(portfolio, prices, cfg));
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, publicSettings(await readSettings()));
  }
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const next = await updateSettings(body);
    return sendJson(res, 200, publicSettings(next));
  }

  if (pathname === '/api/telegram/test' && method === 'POST') {
    const result = await sendTelegramMessage({ text: 'Sally Crypto Bot test message - if you see this, Telegram push is working.' });
    return sendJson(res, result.sent ? 200 : 400, result);
  }
  if (pathname === '/api/telegram/status' && method === 'GET') {
    return sendJson(res, 200, await getTelegramStatus());
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    return sendJson(res, 200, { items: await notifications.list() });
  }
  if (pathname === '/api/notifications/read' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { items: await notifications.markRead(body.ids || []) });
  }

  return serveStatic(req, res, pathname);
}

// Surfaces the most recent .claude/skills/backtest-expert verdict on the
// dashboard, so "auto-trade is enabled" is never seen in isolation from
// "and here's whether the last backtest actually cleared Deploy." Reads
// through storage.js (same file-or-Postgres dual-mode as everything else),
// so this shows a result whether it was written by the in-app "Run backtest"
// button (POST /api/backtest/run, above) or by running the backtest-expert
// CLI skill directly on your own machine - both write to the same key.
async function loadLatestBacktestVerdict() {
  const stored = await readJson(VERDICT_KEY, null);
  return stored || { available: false };
}

async function refreshOne(symbol, opts = {}) {
  const result = await refreshSymbol(symbol, { notifications, broadcast: (m) => hub.broadcast(m), ...opts });
  latestBySymbol.set(symbol, result);
  return result;
}

// --- 24/7 auto-refresh loop -------------------------------------------------
// Runs every REFRESH_INTERVAL_SEC for every symbol on the watchlist, entirely
// independent of anyone having the dashboard open - the point of "trade 24/7"
// is that this loop keeps going as long as the Node process is running.
let refreshInFlight = false;
async function tick() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const settings = await readSettings();
    for (const symbol of settings.watchlist) {
      await refreshOne(symbol).catch((error) => console.warn(`[tick] ${symbol} failed:`, error.message));
    }
  } finally {
    refreshInFlight = false;
  }
}

// --- static file serving -----------------------------------------------------
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(config.publicDir, relative));
  if (!filePath.startsWith(config.publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60'
    });
    res.end(data);
  } catch {
    if (relative !== 'index.html') return serveStatic(req, res, '/');
    res.writeHead(404);
    res.end('Not found');
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// Self-rescheduling instead of a fixed setInterval, so refreshIntervalSec -
// now a DB-backed setting, not an env var read once at startup - can be
// changed from the Settings page and take effect on the very next cycle.
async function scheduleTick() {
  await tick().catch((error) => console.warn('[tick] failed:', error.message));
  const settings = await readSettings().catch(() => null);
  const intervalSec = settings?.refreshIntervalSec ?? 60;
  setTimeout(scheduleTick, intervalSec * 1000);
}

server.listen(config.port, () => {
  console.log(`robocrypto listening on http://localhost:${config.port}`);
  scheduleTick(); // runs once immediately, then reschedules itself using the current setting each time
});
