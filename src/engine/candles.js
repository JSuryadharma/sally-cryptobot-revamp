import { fetchKlines } from '../binanceData.js';
import { enrichCandles } from '../indicators.js';
import { TF_MS, ENGINE_TIMEFRAMES } from './config.js';

const LIVE_LIMITS = { '15m': 700, '1h': 400, '4h': 400, '1d': 400 };
const FETCH_CONCURRENCY = 8;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetches every engine timeframe for each symbol. Returns closed, enriched
// candles per timeframe plus the still-forming candle (for display prices).
export async function loadLiveSeries(symbols, { baseUrl, nowMs = Date.now() } = {}) {
  const jobs = symbols.flatMap((symbol) => ENGINE_TIMEFRAMES.map((tf) => ({ symbol, tf })));
  const series = {};
  const live = {};
  const errors = [];
  await mapLimit(jobs, FETCH_CONCURRENCY, async ({ symbol, tf }) => {
    try {
      const raw = await fetchKlines(symbol, tf, LIVE_LIMITS[tf], baseUrl);
      const enriched = enrichCandles(raw);
      const lastClosed = enriched.length && nowMs >= raw.at(-1).closeTime ? enriched.length : enriched.length - 1;
      (series[symbol] ||= {})[tf] = enriched.slice(0, lastClosed);
      (live[symbol] ||= {})[tf] = enriched.at(-1) || null;
    } catch (error) {
      errors.push({ symbol, tf, error: error.message });
    }
  });
  for (const { symbol } of errors) delete series[symbol];
  return { series, live, errors };
}

async function fetchJsonWithRetry(url, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
      return await response.json();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Paginates Binance's 1000-candle limit to cover [startMs, endMs). Only fully
// closed candles are returned.
export async function fetchKlinesRange(baseUrl, symbol, tf, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJsonWithRetry(url);
    if (!rows.length) break;
    for (const row of rows) {
      const closeTime = Number(row[6]);
      if (closeTime >= endMs) continue;
      out.push({
        time: Math.floor(row[0] / 1000),
        date: new Date(row[0]).toISOString().slice(0, 10),
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
        volume: Number(row[5]), closeTime
      });
    }
    const nextCursor = rows.at(-1)[0] + TF_MS[tf];
    if (nextCursor <= cursor || rows.length < 1000) break;
    cursor = nextCursor;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return out;
}

export const WARMUP_BARS = 200;

export async function loadHistorySeries(symbols, { baseUrl, startMs, endMs, log = () => {} }) {
  const series = {};
  for (const symbol of symbols) {
    log(`Fetching ${symbol}...`);
    series[symbol] = {};
    for (const tf of ENGINE_TIMEFRAMES) {
      const raw = await fetchKlinesRange(baseUrl, symbol, tf, startMs - WARMUP_BARS * TF_MS[tf], endMs);
      series[symbol][tf] = enrichCandles(raw);
    }
  }
  return series;
}
