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
import { checkBearer } from './auth.js';
import { handleTickRequest, readEngineStatus, readPredictionAccuracy, runTick, runTickIfDue, runManualTrade } from './engine/tick.js';
import { loadChartCandles } from './engine/candles.js';

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

// Backtest runs are open (no admin token): they only read public market data
// and overwrite the stored backtest verdict.
const ADMIN_ROUTES = [
  /^\/api\/settings$/,
  /^\/api\/coins\/[A-Z0-9]+\/trade$/i,
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
  if (pathname === '/api/predictions/accuracy' && method === 'GET') {
    return sendJson(res, 200, await readPredictionAccuracy());
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
        engineCfg: engineCfgFromSettings(settings),
        tradeAllocationPct: settings.tradeAllocationPct
      });
      return sendJson(res, 200, payload);
    } catch (error) {
      console.error('[api/backtest/run] failed:', error);
      return sendJson(res, 500, { error: error.message || 'Backtest run failed.' });
    }
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    const settings = await readSettings();
    const [portfolio, { coins }, usdIdrRate] = await Promise.all([
      getPortfolio(settings), readCoinsCache(), resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl)
    ]);
    const prices = {};
    for (const symbol of Object.keys(portfolio.positions)) prices[symbol] = coins[symbol]?.latest?.close;
    return sendJson(res, 200, markToMarket(portfolio, prices, usdIdrRate));
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, publicSettings(await readSettings()));
  }
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, publicSettings(await updateSettings(body)));
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
