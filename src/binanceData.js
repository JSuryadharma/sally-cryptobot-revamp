// All public, unauthenticated Binance market-data endpoints - no API key, no
// account login, no order placement. This module only ever reads data.
//
// Default base URL is data-api.binance.vision, Binance's own dedicated
// public market-data mirror (same responses as api.binance.com's /api/v3/*
// market-data endpoints, just without the geo-restrictions that api.binance.com
// itself applies in a handful of countries). Override via Settings ->
// binanceBaseUrl (DB-backed, see settings.js) if you specifically want
// api.binance.com instead - every function below takes it as a parameter
// rather than reading a module-level default, so callers always use
// whatever's actually configured right now, not a value baked in at startup.
const DEFAULT_BINANCE_BASE_URL = 'https://data-api.binance.vision';

export const INTERVAL_BY_MODE = { swing: '1d', scalping: '15m', dayTrade: '1h' };
const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s - check this machine's internet access to ${new URL(url).host}.`);
    }
    // Node's fetch wraps DNS/connection failures as "fetch failed" with the
    // real reason in .cause - surface that instead of the useless outer message.
    const cause = error.cause?.message || error.cause?.code;
    throw new Error(`${label} failed: ${cause ? `${error.message} (${cause})` : error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchKlines(symbol, mode, limit = 400, baseUrl = DEFAULT_BINANCE_BASE_URL) {
  const interval = INTERVAL_BY_MODE[mode] || mode;
  const url = `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const rows = await fetchJson(url, `Binance klines (${symbol} ${interval})`);
  return rows.map((row) => ({
    time: Math.floor(row[0] / 1000),
    date: new Date(row[0]).toISOString().slice(0, 10),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    // Binance's klines endpoint, called with no explicit end time, always
    // returns the currently-forming candle as the last row - its close is
    // just the latest trade price, still changing until this timestamp
    // passes. closeTime (row[6], ms) is what marketData.js uses to tell a
    // settled candle from a live one - see its own comment for why that
    // distinction matters to the trading logic, not just display.
    closeTime: Number(row[6])
  }));
}

let tickerCache = null;
let tickerCacheAt = 0;
let tickerInFlight = null; // de-dupes concurrent callers (e.g. several browser polls landing at once) into one request
const TICKER_TTL_MS = 45_000;

export async function fetch24hrTickers(baseUrl = DEFAULT_BINANCE_BASE_URL) {
  const now = Date.now();
  if (tickerCache && now - tickerCacheAt < TICKER_TTL_MS) return tickerCache;
  if (tickerInFlight) return tickerInFlight;

  tickerInFlight = (async () => {
    const url = `${baseUrl}/api/v3/ticker/24hr`;
    const all = await fetchJson(url, 'Binance 24hr ticker');
    tickerCache = all.filter((t) => t.symbol.endsWith('USDT'));
    tickerCacheAt = Date.now();
    return tickerCache;
  })();
  try {
    return await tickerInFlight;
  } finally {
    tickerInFlight = null;
  }
}

export async function fetchTickersFor(symbols, baseUrl = DEFAULT_BINANCE_BASE_URL) {
  const all = await fetch24hrTickers(baseUrl);
  const set = new Set(symbols);
  return all.filter((t) => set.has(t.symbol));
}

// "Most recommended coins" = liquid USDT pairs with the biggest 24h move,
// filtered to a minimum turnover so illiquid pairs (where slippage would be
// unrealistic for a paper-trading demo anyway) don't show up.
export async function fetchTopMovers({ limit = 6, minQuoteVolumeUsdt = 5_000_000, baseUrl = DEFAULT_BINANCE_BASE_URL } = {}) {
  const all = await fetch24hrTickers(baseUrl);
  return all
    .filter((t) => Number(t.quoteVolume) >= minQuoteVolumeUsdt)
    .filter((t) => !['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT'].includes(t.symbol)) // skip stablecoin pairs
    .sort((a, b) => Math.abs(Number(b.priceChangePercent)) - Math.abs(Number(a.priceChangePercent)))
    .slice(0, limit)
    .map(toTickerSummary);
}

export function toTickerSummary(t) {
  return {
    symbol: t.symbol,
    price: Number(t.lastPrice),
    changePct: Number(t.priceChangePercent),
    high24h: Number(t.highPrice),
    low24h: Number(t.lowPrice),
    quoteVolume: Number(t.quoteVolume)
  };
}

// Live USD/IDR rate, straight from Binance's own USDT/IDR spot pair - the
// same domain/fetch pattern this file already uses for everything else, so
// no new external dependency (no exchange-rate API to sign up for or trust).
// This is also the most relevant rate for this app specifically: every price
// robocrypto ever converts is already USDT-denominated, so pricing that
// conversion off the same exchange it trades on is more consistent than an
// official/interbank USD/IDR reference rate would be.
let usdIdrCache = null;
let usdIdrCacheAt = 0;
let usdIdrInFlight = null;
const USD_IDR_TTL_MS = 5 * 60_000;

export async function fetchLiveUsdIdrRate(baseUrl = DEFAULT_BINANCE_BASE_URL) {
  const now = Date.now();
  if (usdIdrCache != null && now - usdIdrCacheAt < USD_IDR_TTL_MS) return usdIdrCache;
  if (usdIdrInFlight) return usdIdrInFlight;

  usdIdrInFlight = (async () => {
    const url = `${baseUrl}/api/v3/ticker/price?symbol=USDTIDR`;
    const row = await fetchJson(url, 'Binance USDT/IDR rate');
    const rate = Number(row.price);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Binance USDT/IDR rate: unexpected response ${JSON.stringify(row)}`);
    usdIdrCache = rate;
    usdIdrCacheAt = Date.now();
    return rate;
  })();
  try {
    return await usdIdrInFlight;
  } finally {
    usdIdrInFlight = null;
  }
}

// Never lets a live-fetch hiccup (rate limit, network blip, USDTIDR
// temporarily delisted) block a refresh cycle - falls back to whatever rate
// is stored in settings (the same field this replaces as the primary source,
// now just a fallback/manual-override value - see settings.js).
export async function resolveUsdIdrRate(fallbackRate, baseUrl = DEFAULT_BINANCE_BASE_URL) {
  try {
    return await fetchLiveUsdIdrRate(baseUrl);
  } catch (error) {
    console.warn('[binanceData] live USD/IDR fetch failed, using fallback rate:', error.message);
    return fallbackRate;
  }
}
