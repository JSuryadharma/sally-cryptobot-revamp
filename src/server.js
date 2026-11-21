import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { WebSocketHub } from './websocket.js';
import { NotificationCenter, sendTelegramMessage, getTelegramStatus } from './notifications.js';
import { readSettings, updateSettings, publicSettings, engineCfgFromSettings } from './settings.js';
import { getPortfolio, markToMarket } from './tradingRobot.js';
import { fetchTopMovers, fetchTickersFor, resolveUsdIdrRate } from './binanceData.js';
import { analyzeStructure } from './marketStructure.js';
import { readJson } from './storage.js';
import { runAndStoreBacktest, VERDICT_KEY } from './backtestRunner.js';
import { readCoinsCache } from './coinsCache.js';
import { checkConnection } from './pgClient.js';
import { handleTickRequest, readEngineStatus, readPredictionAccuracy, readPaperBreakout, readPaperGap, runTick, runTickIfDue, runManualTrade, readAutopilot, runIdxManualTrade, readIdx, readCryptoInsights } from './engine/tick.js';
import { accountSnapshot } from './account.js';
import { fetchIdxDaily, normalizeIdxSymbol } from './markets/idx.js';
import { enrichCandles } from './indicators.js';
import { correlateNews, NEWS_JOURNAL_KEY, PRICE_HISTORY_KEY } from './news/service.js';
import { NEWS_STATE_KEY } from './engine/tick.js';
import { loadChartCandles } from './engine/candles.js';
import { resetData } from './engine/reset.js';
import { brokerStatus, testBinance } from './brokers/execution.js';

const notifications = new NotificationCenter();
const CHART_TFS = ['15m', '1h', '4h', '1d'];
const LEGACY_CHART_MODES = { scalping: '15m', dayTrade: '1h', '4h': '4h', swing: '1d' };
const CHART_WINDOW = { '15m': 192, '1h': 120, '4h': 90, '1d': 120 };

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error.code === 'LEASE_BUSY') return sendJson(res, 409, { error: error.message });
    console.error('[server] unhandled error:', error);
    sendJson(res, 500, { error: error.message || 'Internal error' });
  });
});

const hub = new WebSocketHub(server);
notifications.setBroadcast((message) => hub.broadcast(message));

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = stripBasePath(url.pathname);
  if (pathname === null) {
    res.writeHead(302, { Location: `${config.basePath}/${url.search}` });
    return res.end();
  }
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

  // Only one scheduler at a time: while the built-in timer runs, the external tick URL is off.
  if (pathname === '/api/engine/tick' && localLoopEnabled) {
    return sendJson(res, 404, { error: 'Disabled: this server ticks itself (ENGINE_LOCAL_LOOP=on).' });
  }
  if (pathname === '/api/engine/tick') {
    const { status, body } = await handleTickRequest(req);
    return sendJson(res, status, body);
  }

  if (pathname === '/api/admin/reset' && method === 'POST') {
    const body = await readBody(req);
    const { status, body: result } = await resetData(String(body.scope || ''));
    return sendJson(res, status, result);
  }

  if (pathname === '/api/engine/status' && method === 'GET') {
    return sendJson(res, 200, await readEngineStatus());
  }

  // Read-only: trading happens only in the engine tick (src/engine/tick.js).
  if (pathname === '/api/predictions/accuracy' && method === 'GET') {
    return sendJson(res, 200, await readPredictionAccuracy());
  }

  if (pathname === '/api/paper/breakout' && method === 'GET') {
    return sendJson(res, 200, await readPaperBreakout());
  }

  if (pathname === '/api/paper/gap' && method === 'GET') {
    return sendJson(res, 200, await readPaperGap());
  }

  if (pathname === '/api/coins' && method === 'GET') {
    const settings = await readSettings();
    const { coins: sharedCache, updatedAt } = await readCoinsCache();
    const results = settings.watchlist.map((symbol) => sharedCache[symbol]).filter(Boolean);
    return sendJson(res, 200, { coins: results, watchlist: settings.watchlist, updatedAt });
  }

  // Live prices between engine ticks. Binance's 24h ticker is cached ~45s in binanceData.js.
  if (pathname === '/api/prices' && method === 'GET') {
    const settings = await readSettings();
    const portfolio = await getPortfolio(settings);
    const symbols = [...new Set([...settings.watchlist, ...Object.keys(portfolio.positions || {})])];
    try {
      const tickers = await fetchTickersFor(symbols, settings.binanceBaseUrl);
      const prices = Object.fromEntries(tickers.map((t) => [t.symbol, { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent) }]));
      return sendJson(res, 200, { prices, at: new Date().toISOString() });
    } catch (error) {
      return sendJson(res, 200, { prices: {}, error: error.message });
    }
  }

  if (pathname === '/api/coins/refresh-all' && method === 'POST') {
    try {
      return sendJson(res, 200, await runTickIfDue({ reason: 'dashboard' }));
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

  const tradeMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/trade$/i);
  if (tradeMatch && method === 'POST') {
    const body = await readBody(req);
    const { status, body: result } = await runManualTrade(tradeMatch[1].toUpperCase(), String(body.action || '').toUpperCase());
    return sendJson(res, status, result);
  }

  const candlesMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)\/candles$/i);
  if (candlesMatch && method === 'GET') {
    const symbol = candlesMatch[1].toUpperCase();
    const requested = url.searchParams.get('tf') || LEGACY_CHART_MODES[url.searchParams.get('mode')];
    const tf = CHART_TFS.includes(requested) ? requested : '4h';
    const settings = await readSettings();
    const candles = await loadChartCandles(symbol, tf, { baseUrl: settings.binanceBaseUrl });
    const trimmed = candles.slice(-CHART_WINDOW[tf]).map((c) => ({
      time: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      ema9: c.ema9, ema20: c.ema20, ema50: c.ema50, atr14: c.atr14
    }));
    return sendJson(res, 200, { symbol, tf, candles: trimmed, structure: analyzeStructure(candles) });
  }

  if (pathname === '/api/movers' && method === 'GET') {
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
    return sendJson(res, 200, (await readJson(VERDICT_KEY, null)) || { available: false });
  }

  if (pathname === '/api/backtest/run' && method === 'POST') {
    const body = await readBody(req);
    const settings = await readSettings();
    try {
      const payload = await runAndStoreBacktest({
        symbols: body.symbols || settings.watchlist,
        months: Math.min(Number(body.months) || 1, 6),
        baseUrl: settings.binanceBaseUrl,
        engineCfg: engineCfgFromSettings(settings, await readAutopilot()),
        tradeAllocationPct: settings.tradeAllocationPct
      });
      return sendJson(res, 200, payload);
    } catch (error) {
      console.error('[api/backtest/run] failed:', error);
      return sendJson(res, 500, { error: error.message || 'Backtest run failed.' });
    }
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    const { portfolio, prices, usdIdrRate } = await accountInputs();
    const account = accountSnapshot(portfolio, prices, { crypto: usdIdrRate, idx: 1 });
    // Crypto fields as before; equity and return now cover the whole account (both books).
    return sendJson(res, 200, { ...markToMarket(portfolio, prices.crypto, usdIdrRate), equityIdr: account.equityIdr, totalReturnPct: account.totalReturnPct, account });
  }

  // One cash pool, two books: crypto and IDX stocks (src/account.js).
  if (pathname === '/api/account' && method === 'GET') {
    const { portfolio, prices, usdIdrRate } = await accountInputs();
    const snapshot = accountSnapshot(portfolio, prices, { crypto: usdIdrRate, idx: 1 });
    const transactions = (portfolio.transactions || []).slice(0, 40).map((t) => ({ ...t, market: t.market || 'crypto' }));
    return sendJson(res, 200, { ...snapshot, usdIdrRate, transactions });
  }

  if (pathname === '/api/idx' && method === 'GET') {
    return sendJson(res, 200, await readIdx());
  }

  const idxTrade = pathname.match(/^\/api\/idx\/([A-Z]{4})\/trade$/i);
  if (idxTrade && method === 'POST') {
    const body = await readBody(req);
    const { status, body: result } = await runIdxManualTrade(idxTrade[1].toUpperCase(), String(body.action || '').toUpperCase());
    return sendJson(res, status, result);
  }

  const idxCandles = pathname.match(/^\/api\/idx\/([A-Z]{4}|IHSG)\/candles$/i);
  if (idxCandles && method === 'GET') {
    const symbol = idxCandles[1].toUpperCase();
    try {
      const candles = await idxChartCandles(symbol === 'IHSG' ? symbol : normalizeIdxSymbol(symbol));
      return sendJson(res, 200, { symbol, tf: '1d', candles: candles.slice(-CHART_WINDOW['1d']).map((c) => ({ time: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, ema20: c.ema20, ema50: c.ema50, atr14: c.atr14 })), structure: analyzeStructure(candles) });
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }

  if (pathname === '/api/insights' && method === 'GET') {
    return sendJson(res, 200, await readCryptoInsights());
  }

  if (pathname === '/api/news' && method === 'GET') {
    const [journal, history, state, idx, { coins }] = await Promise.all([
      readJson(NEWS_JOURNAL_KEY, []), readJson(PRICE_HISTORY_KEY, {}), readJson(NEWS_STATE_KEY, null), readIdx(), readCoinsCache()
    ]);
    const live = {
      crypto: Object.fromEntries(Object.entries(coins).map(([s, c]) => [s, c?.latest?.close]).filter(([, v]) => Number.isFinite(v))),
      idx: Object.fromEntries(idx.stocks.map((st) => [st.symbol, st.price]))
    };
    const { items, tickers } = correlateNews(journal, history, live, { days: 14 });
    const market = url.searchParams.get('market');
    const symbol = url.searchParams.get('symbol')?.toUpperCase();
    let list = items;
    if (market) list = list.filter((n) => n.market === market || n.tickers.some((t) => t.market === market));
    if (symbol) list = list.filter((n) => n.tickers.some((t) => t.symbol === symbol));
    return sendJson(res, 200, {
      items: list.slice(0, Number(url.searchParams.get('limit')) || 60),
      tickers,
      updatedAt: state?.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
      feedErrors: state?.errors || []
    });
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, publicSettings(await readSettings()));
  }
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, publicSettings(await updateSettings(body)));
  }

  if (pathname === '/api/broker/status' && method === 'GET') {
    return sendJson(res, 200, await brokerStatus({ settings: await readSettings() }));
  }
  if (pathname === '/api/broker/test' && method === 'POST') {
    const result = await testBinance();
    return sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ...result, error: result.message });
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

// Prices for marking both books to market: crypto from the last engine pass's
// coin cache, IDX from the last IDX pass.
async function accountInputs() {
  const settings = await readSettings();
  const [portfolio, { coins }, usdIdrRate, idx] = await Promise.all([
    getPortfolio(settings), readCoinsCache(), resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl), readIdx()
  ]);
  const prices = { crypto: {}, idx: {} };
  for (const symbol of Object.keys(portfolio.positions || {})) prices.crypto[symbol] = coins[symbol]?.latest?.close;
  for (const stock of idx.stocks) prices.idx[stock.symbol] = stock.price;
  return { portfolio, prices, usdIdrRate };
}

const idxChartCache = new Map();
async function idxChartCandles(symbol) {
  if (!symbol) throw new Error('Not an IDX ticker.');
  const cached = idxChartCache.get(symbol);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.candles;
  const { candles } = await fetchIdxDaily(symbol, { range: '1y' });
  const enriched = enrichCandles(candles);
  idxChartCache.set(symbol, { at: Date.now(), candles: enriched });
  return enriched;
}

// With BASE_PATH=/sally, "/sally/api/x" is routed as "/api/x" and only "/sally" returns
// null (redirect to "/sally/"). Unprefixed paths, "/" included, are served as-is: a proxy
// that strips the prefix (nginx `proxy_pass http://127.0.0.1:3300/;`, Caddy `handle_path`)
// sends "/sally/" here as "/", and redirecting that back to "/sally/" loops forever.
// The container's health check and an old cron-job.org URL keep working too.
function stripBasePath(pathname) {
  const base = config.basePath;
  if (!base) return pathname;
  if (pathname === base) return null;
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
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
    let data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    if (ext === '.html' && config.basePath) data = withBasePath(data.toString('utf8'));
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

// Points the page's own links and its API calls (public/app.js reads the meta tag) at BASE_PATH.
function withBasePath(html) {
  return html
    .replace(/(href|src)="\/(?!\/)/g, `$1="${config.basePath}/`)
    .replace('<head>', `<head>\n<meta name="base-path" content="${config.basePath}" />`);
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

// Local/persistent-host scheduler. On Vercel an external scheduler (cron-job.org) calls
// /api/engine/tick instead, because serverless instances don't keep timers alive.
// The timer and POST /api/engine/tick are mutually exclusive: with the timer on (the default
// off-Vercel) the tick URL answers 404; ENGINE_LOCAL_LOOP=off switches back to an external
// scheduler such as cron-job.org.
const localLoopEnabled = !process.env.VERCEL && process.env.ENGINE_LOCAL_LOOP !== 'off';
let tickTimer = null;

async function scheduleTick() {
  await runTick({ reason: 'local-loop' }).catch((error) => console.warn('[tick] failed:', error.message));
  const settings = await readSettings().catch(() => null);
  const intervalSec = settings?.refreshIntervalSec ?? 60;
  tickTimer = setTimeout(scheduleTick, intervalSec * 1000);
}

server.listen(config.port, () => {
  console.log(`robocrypto listening on http://localhost:${config.port}${config.basePath}/`);
  console.log(localLoopEnabled ? '[tick] built-in timer on - POST /api/engine/tick is disabled' : '[tick] built-in timer off - waiting for POST /api/engine/tick');
  if (localLoopEnabled) scheduleTick();
});

// `docker stop` / systemd send SIGTERM. Stop taking requests and exit; an interrupted
// tick is safe because its writes are one transaction and the lease expires on its own.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`[server] ${signal} received, shutting down`);
    clearTimeout(tickTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
