import { fetchKlines, INTERVAL_BY_MODE } from './binanceData.js';
import { enrichCandles } from './indicators.js';

// In-memory cache only (per running process) - this is a single-instance 24/7
// server, not a multi-node deployment, so there's no need for a shared cache
// store. TTLs are shorter than the candle interval itself so the dashboard
// still feels live without hammering Binance's public rate limit.
// '4h' is a chart-only timeframe, not a trading mode - there's no strategy
// tied to it (see STRATEGY_PARAMS in decisionEngine.js), it just gives the
// chart/structure view a fourth option between 1h and 1D. fetchKlines()
// already falls back to using the mode string itself as the Binance interval
// when it's not one of swing/scalping/dayTrade, so '4h' works unchanged.
const CACHE_TTL_MS = { swing: 10 * 60_000, scalping: 2 * 60_000, dayTrade: 5 * 60_000, '4h': 15 * 60_000 };
const cache = new Map();

// Raw kline fetch count per mode - historically a flat 400 everywhere. The
// chart's display window was narrowed (2026-09-20, chat) to the trailing 7
// days for the intraday timeframes - server.js's /candles route slices this
// down further - and 15m needs 672 candles to cover 7 days, more than the
// flat 400 covered (only ~4 days). The other modes stay at 400: already far
// more than a week (1h -> ~16 days, 4h -> ~66 days, 1D -> ~13 months) so
// nothing else needs to change. A longer raw fetch never hurts the live
// strategy's own indicator warm-up either (EMA/RSI/ATR only get more settled
// with more lookback), so this is safe to share with loadSnapshot's normal
// (non-chart) callers too.
const RAW_FETCH_LIMIT = { scalping: 700 };

export async function loadSnapshot(symbol, mode, { force = false, baseUrl } = {}) {
  const key = `${symbol}:${mode}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < (CACHE_TTL_MS[mode] ?? 5 * 60_000)) {
    return cached.snapshot;
  }
  const raw = await fetchKlines(symbol, mode, RAW_FETCH_LIMIT[mode] || 400, baseUrl);
  const candles = enrichCandles(raw);

  // Binance's klines response (fetched with no end time) always includes the
  // currently-forming candle as the last row - its close/high/low are just
  // the latest trade, still moving until closeTime passes. `candles`/`latest`
  // above keep including it, since the live price ticker, the chart, and
  // mark-to-market SHOULD track the real live price.
  //
  // The trading logic must not, though: evaluateEntry/evaluateExit treat
  // "the latest candle" as one settled, once-per-bar decision point (a
  // "fresh EMA cross," a stop-loss check against a candle's close) - built
  // on the assumption every candle in the series is final. Fed the live
  // candle instead, a routine intrabar wick can trip a stop-loss (or look
  // like a fresh cross) minutes into a brand-new position, before the bar
  // that supposedly triggered it has even closed - indistinguishable from a
  // real signal in the trade log, but really just noise the system was
  // never designed to react to mid-bar. `closedCandles`/`closedLatest` are
  // what robotEngine.js feeds the decision functions instead.
  const lastRaw = raw.at(-1);
  const lastIsClosed = !lastRaw || now >= lastRaw.closeTime;
  const closedCandles = lastIsClosed ? candles : candles.slice(0, -1);

  const latest = candles.at(-1) || null;
  const previous = candles.at(-2) || null;
  const snapshot = {
    symbol,
    mode,
    interval: INTERVAL_BY_MODE[mode] || mode,
    fetchedAt: new Date(now).toISOString(),
    candleCount: candles.length,
    latest,
    previous,
    candles,
    closedCandles,
    closedLatest: closedCandles.at(-1) || null
  };
  cache.set(key, { snapshot, fetchedAt: now });
  return snapshot;
}

// Convenience: load all three timeframes for one coin at once (used by the
// regime picker, which needs to compare trend strength across horizons).
export async function loadAllModes(symbol, opts) {
  const [swing, scalping, dayTrade] = await Promise.all([
    loadSnapshot(symbol, 'swing', opts),
    loadSnapshot(symbol, 'scalping', opts),
    loadSnapshot(symbol, 'dayTrade', opts)
  ]);
  return { swing, scalping, dayTrade };
}

export function clearCache() {
  cache.clear();
}
