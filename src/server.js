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
import { readCoinsCache, writeCoinCacheEntry } from './refreshWatchlist.js';
import { checkConnection } from './pgClient.js';
import { checkBearer } from './auth.js';
import { handleTickRequest, readEngineStatus, runTick, runTickIfDue, withEngineLease } from './engine/tick.js';

const notifications = new NotificationCenter();
// '4h' is chart-only (see marketData.js) - not one of the three trading modes.
const CHART_TIMEFRAMES = ['swing', 'scalping', 'dayTrade', '4h'];

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error.code === 'LEASE_BUSY') return sendJson(res, 409, { error: error.message });
    console.error('[server] unhandled error:', error);
    sendJson(res, 500, { error: error.message || 'Internal error' });
  });
});

const hub = new WebSocketHub(server);
notifications.setBroadcast((message) => hub.broadcast(message));

const ADMIN_ROUTES = [
  /^\/api\/settings$/,
  /^\/api\/coins\/[A-Z0-9]+\/(trade|refresh)$/i,
  /^\/api\/backtest\/run$/,
  /^\/api\/telegram\/test$/,
  /^\/api\/notifications\/read$/
];

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method !== 'GET' && ADMIN_ROUTES.some((pattern) => pattern.test(pathname))) {
    const denied = checkBearer(req, 'ADMIN_TOKEN');
    if (denied) return sendJson(res, denied.status, { error: denied.error });
  }

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

  if (pathname === '/api/engine/tick') {
    const { status, body } = await handleTickRequest(req);
    return sendJson(res, status, body);
  }

  if (pathname === '/api/engine/status' && method === 'GET') {
    return sendJson(res, 200, await readEngineStatus());
  }

  // Read-only: trading happens only in the engine tick (src/engine/tick.js).
  if (pathname === '/api/coins' && method === 'GET') {
    const settings = await readSettings();
    const { coins: sharedCache, updatedAt } = await readCoinsCache();
    const results = settings.watchlist.map((symbol) => sharedCache[symbol]).filter(Boolean);
    return sendJson(res, 200, { coins: results, watchlist: settings.watchlist, updatedAt });
  }

  if (pathname === '/api/coins/refresh-all' && method === 'POST') {
    try {
      const result = await runTickIfDue({ reason: 'dashboard' });
      return sendJson(res, 200, result);
    } catch (error) {
      console.error('[api/coins/refresh-all] failed:', error);
      return sendJson(res, 500, { error: error.message || 'Refresh failed.' });
    }
  }

  const coinMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)$/i);
  if (coinMatch && method === 'GET') {
    const symbol = coinMatch[1].toUpperCase();
    let { coins: sharedCache } = await readCoinsCache();
    if (!sharedCache[symbol]) {
      // A just-added watchlist coin has no cache entry until the next tick.
      await runTickIfDue({ reason: 'new-coin' }).catch((error) => console.warn('[api/coins/:symbol] tick failed:', error.message));
      ({ coins: sharedCache } = await readCoinsCache());
    }
    if (!sharedCache[symbol]) return sendJson(res, 404, { error: `${symbol} has not been scanned yet - it appears after the next engine tick.` });
    return sendJson(res, 200, sharedCache[symbol]);
  }

  const refreshMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/refresh$/i);
  if (refreshMatch && method === 'POST') {
    const symbol = refreshMatch[1].toUpperCase();
    return sendJson(res, 200, await withEngineLease(() => refreshOne(symbol, { force: true })));
  }

  const tradeMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/trade$/i);
  if (tradeMatch && method === 'POST') {
    const symbol = tradeMatch[1].toUpperCase();
    const body = await readBody(req);
    const action = String(body.action || '').toUpperCase();
    return sendJson(res, ...(await withEngineLease(() => manualTrade(symbol, action))));
  }

  const candlesMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/candles$/i);
  if (candlesMatch && method === 'GET') {
    const symbol = candlesMatch[1].toUpperCase();
    const mode = CHART_TIMEFRAMES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'swing';
    const snapshot = await loadSnapshot(symbol, mode);
    // EMA fields are included (not just OHLCV) so the chart can draw the
    // EMA 9/20/50 lines and mark fresh crosses itself, instead of just
    // plotting close price - see CHART_EMA_TRIO in app.js. atr14 is included
    // so the chart can annotate the current candle's volatility band
    // (close +/- 1x ATR14).
    // Chart display window: narrowed (2026-09-20/22, chat) to the trailing 7
    // days for the intraday timeframes (15m/1h/4H) and the trailing 30 days
    // (~1 month) for the daily/swing chart - was 120 days (~4 months), which
    // read as noise once you were looking for a specific setup rather than
    // the broad regime. This only trims what's SENT to the chart;
    // analyzeStructure() below still reads the full snapshot.candles (up to
    // ~400 raw candles per mode - see marketData.js's RAW_FETCH_LIMIT), so
    // support/resistance/BOS/CHoCH detection - and EMA9/20/50 themselves,
    // which are computed over that full history before this trim - are
    // unaffected by how few candles end up on screen.
    const CHART_WINDOW_CANDLES = { scalping: 7 * 24 * 4, dayTrade: 7 * 24, '4h': Math.round(7 * 24 / 4), swing: 30 };
    const windowSize = CHART_WINDOW_CANDLES[mode] ?? 30;
    const trimmed = snapshot.candles.slice(-windowSize).map((c) => ({
      time: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      ema9: c.ema9, ema20: c.ema20, ema21: c.ema21, ema50: c.ema50, atr14: c.atr14
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
    const { coins } = await readCoinsCache();
    const prices = {};
    for (const symbol of Object.keys(portfolio.positions)) {
      prices[symbol] = coins[symbol]?.latest?.close;
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
  await writeCoinCacheEntry(symbol, result);
  return result;
}

// Caller holds the engine lease.
async function manualTrade(symbol, action) {
  if (action !== 'BUY' && action !== 'SELL') return [400, { error: 'action must be BUY or SELL.' }];
  const { coins } = await readCoinsCache();
  const cached = coins[symbol];
  if (!cached) return [400, { error: 'Coin has not been scanned yet - try again after the next engine tick.' }];

  const settings = await readSettings();
  const cfg = await portfolioCfg(settings);
  if (action === 'BUY') {
    const mode = cached.activeMode;
    const rrMultiple = RR_TEMPLATES[settings.autoTrade.riskRewardTemplate]?.ratio ?? RR_TEMPLATES.balanced.ratio;
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
    return [200, result];
  }
  const portfolio = await getPortfolio(cfg);
  const position = portfolio.positions[symbol];
  if (!position) return [400, { error: 'No open position to sell.' }];
  const price = cached.latest?.close ?? position.entryPrice;
  const result = await closePosition({ symbol, exitPrice: price, reason: 'Manual sell - user override.' }, cfg);
  if (result.transaction) {
    const pnl = Math.round(result.transaction.realizedProfitIdr).toLocaleString('id-ID');
    await notifications.notify({ title: `Manual SELL ${symbol}`, message: `Sold at ${price}. P&L: Rp ${pnl}.`, level: result.transaction.realizedProfitIdr >= 0 ? 'success' : 'warning', category: 'trade' });
  }
  await refreshOne(symbol, { force: true });
  return [200, result];
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

// Local/persistent-host scheduler. On Vercel the GitHub Actions workflow calls
// /api/engine/tick instead, because serverless instances don't keep timers alive.
async function scheduleTick() {
  await runTick({ reason: 'local-loop' }).catch((error) => console.warn('[tick] failed:', error.message));
  const settings = await readSettings().catch(() => null);
  const intervalSec = settings?.refreshIntervalSec ?? 60;
  setTimeout(scheduleTick, intervalSec * 1000);
}

server.listen(config.port, () => {
  console.log(`robocrypto listening on http://localhost:${config.port}`);
  if (!process.env.VERCEL) scheduleTick();
});
