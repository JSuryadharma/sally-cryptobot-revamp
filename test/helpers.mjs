import { enrichCandles } from '../src/indicators.js';
import { TF_MS } from '../src/engine/config.js';

export function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random-walk 15m candles with regime-switching drift, so trends, pullbacks
// and breakdowns all occur.
export function synthetic15m({ bars, startMs, startPrice = 100, seed = 1, volume = 400_000 }) {
  const rand = mulberry32(seed);
  const out = [];
  let price = startPrice;
  let drift = 0.0004;
  for (let n = 0; n < bars; n += 1) {
    if (n % 400 === 0) drift = (rand() - 0.4) * 0.0012;
    const open = price;
    const move = drift + (rand() - 0.5) * 0.008;
    const close = Math.max(0.01, open * (1 + move));
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    const time = Math.floor((startMs + n * TF_MS['15m']) / 1000);
    out.push({ time, date: new Date(time * 1000).toISOString().slice(0, 10), open, high, low, close, volume: volume * (0.5 + rand()) });
    price = close;
  }
  return out;
}

export function aggregate(candles15m, tf) {
  const bucketMs = TF_MS[tf];
  const out = [];
  let current = null;
  for (const c of candles15m) {
    const bucket = Math.floor((c.time * 1000) / bucketMs) * bucketMs;
    if (!current || current.bucket !== bucket) {
      if (current) out.push(current.candle);
      current = { bucket, candle: { time: bucket / 1000, date: new Date(bucket).toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } };
    } else {
      current.candle.high = Math.max(current.candle.high, c.high);
      current.candle.low = Math.min(current.candle.low, c.low);
      current.candle.close = c.close;
      current.candle.volume += c.volume;
    }
  }
  if (current) out.push(current.candle);
  return out;
}

// Returns a closed-candle series for every engine timeframe, cut off at nowMs.
export function syntheticSeries({ symbols, bars, startMs, seedBase = 1 }) {
  const series = {};
  symbols.forEach((symbol, k) => {
    const raw = synthetic15m({ bars, startMs, seed: seedBase + k, startPrice: 50 + k * 30 });
    series[symbol] = {
      '15m': enrichCandles(raw),
      '1h': enrichCandles(aggregate(raw, '1h')),
      '4h': enrichCandles(aggregate(raw, '4h')),
      '1d': enrichCandles(aggregate(raw, '1d'))
    };
  });
  return series;
}

export function cutSeries(series, nowMs) {
  const out = {};
  for (const [symbol, byTf] of Object.entries(series)) {
    out[symbol] = {};
    for (const [tf, bars] of Object.entries(byTf)) out[symbol][tf] = bars.filter((b) => b.time * 1000 + TF_MS[tf] <= nowMs);
  }
  return out;
}
