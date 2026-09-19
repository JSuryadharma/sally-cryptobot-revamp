// Price-action "market structure" readout: swing pivots, trend shape, the most
// recent structural break classified as BOS (Break of Structure - trend
// continuation) or CHoCH (Change of Character - the structure just broke
// against the prevailing trend, an early reversal warning), plus nearby
// support/resistance zones clustered from those same pivots.
//
// This is a supplementary, descriptive layer for the chart only - it reads
// swing highs/lows the same way price-action/"smart money concepts" traders
// do, but it does NOT feed decisionEngine.js. The robot's actual entries and
// exits stay exactly the backtested EMA-cross/RSI/ATR rules; this module only
// gives a human a faster read of the chart they're already looking at.

const PIVOT_LOOKBACK = 3; // bars required on each side for a candle to count as a swing high/low
const SR_TOLERANCE_PCT = 0.4; // pivots within this %% of each other are treated as one zone
const SR_MAX_LEVELS = 3;

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

// Fractal pivots: a candle whose high (low) is the highest (lowest) among the
// PIVOT_LOOKBACK candles on either side of it. Simple and timeframe-agnostic -
// works the same whether the candles are 15m, 1h, 4h, or daily.
function findPivots(candles) {
  const highs = [];
  const lows = [];
  for (let i = PIVOT_LOOKBACK; i < candles.length - PIVOT_LOOKBACK; i += 1) {
    const c = candles[i];
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - PIVOT_LOOKBACK; j <= i + PIVOT_LOOKBACK; j += 1) {
      if (j === i) continue;
      if (candles[j].high > c.high) isHigh = false;
      if (candles[j].low < c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: c.time, price: c.high });
    if (isLow) lows.push({ index: i, time: c.time, price: c.low });
  }
  return { highs, lows };
}

// Higher highs + higher lows = uptrend; lower highs + lower lows = downtrend;
// anything else (a high up, a low down, or too little history) is "range."
function classifyTrend(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return 'undefined';
  const higherHighs = highs.at(-1).price > highs.at(-2).price;
  const higherLows = lows.at(-1).price > lows.at(-2).price;
  const lowerHighs = highs.at(-1).price < highs.at(-2).price;
  const lowerLows = lows.at(-1).price < lows.at(-2).price;
  if (higherHighs && higherLows) return 'uptrend';
  if (lowerHighs && lowerLows) return 'downtrend';
  return 'range';
}

// Has the latest close broken past the most recent swing high/low? If so,
// call it BOS when the break agrees with what the swing sequence already
// implied (continuation), or CHoCH when it breaks the *other* way (the
// structure that was building just failed - a change of character).
function classifySignal(candles, highs, lows) {
  const last = candles.at(-1);
  if (!last) return null;
  const lastHigh = highs.at(-1);
  const lastLow = lows.at(-1);
  const prevHigh = highs.at(-2);
  const prevLow = lows.at(-2);

  const brokeAboveHigh = lastHigh && last.time > lastHigh.time && last.close > lastHigh.price;
  const brokeBelowLow = lastLow && last.time > lastLow.time && last.close < lastLow.price;

  if (brokeAboveHigh) {
    const priorStructureWasDown = prevLow && lastLow && lastLow.price < prevLow.price;
    return priorStructureWasDown
      ? {
          type: 'CHoCH', direction: 'bullish', level: round(lastHigh.price),
          description: `Change of Character: price closed above the last swing high (${round(lastHigh.price)}) after a run of lower lows - an early sign the downtrend may be turning up. Not a trade signal by itself.`
        }
      : {
          type: 'BOS', direction: 'bullish', level: round(lastHigh.price),
          description: `Break of Structure: price closed above the last swing high (${round(lastHigh.price)}), confirming the uptrend is still in control.`
        };
  }
  if (brokeBelowLow) {
    const priorStructureWasUp = prevHigh && lastHigh && lastHigh.price > prevHigh.price;
    return priorStructureWasUp
      ? {
          type: 'CHoCH', direction: 'bearish', level: round(lastLow.price),
          description: `Change of Character: price closed below the last swing low (${round(lastLow.price)}) after a run of higher highs - an early sign the uptrend may be turning down. Not a trade signal by itself.`
        }
      : {
          type: 'BOS', direction: 'bearish', level: round(lastLow.price),
          description: `Break of Structure: price closed below the last swing low (${round(lastLow.price)}), confirming the downtrend is still in control.`
        };
  }
  return {
    type: 'None', direction: 'neutral', level: null,
    description: `No fresh structure break - price is ranging between the last swing high (${lastHigh ? round(lastHigh.price) : 'n/a'}) and swing low (${lastLow ? round(lastLow.price) : 'n/a'}).`
  };
}

// Cluster nearby pivot prices into zones (a level that's been touched more
// than once is a stronger S/R zone than a single spike), then keep only the
// zones on the correct side of the current price, nearest first.
function clusterPrices(prices) {
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters = [];
  for (const price of sorted) {
    const last = clusters.at(-1);
    if (last && Math.abs(price - last.avg) / last.avg * 100 <= SR_TOLERANCE_PCT) {
      last.prices.push(price);
      last.avg = last.prices.reduce((sum, p) => sum + p, 0) / last.prices.length;
    } else {
      clusters.push({ prices: [price], avg: price });
    }
  }
  return clusters.map((c) => ({ price: round(c.avg), touches: c.prices.length }));
}

function nearestLevels(candles, highs, lows) {
  const currentPrice = candles.at(-1)?.close;
  if (!Number.isFinite(currentPrice)) return { support: [], resistance: [] };
  const resistance = clusterPrices(highs.map((h) => h.price))
    .filter((z) => z.price > currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, SR_MAX_LEVELS);
  const support = clusterPrices(lows.map((l) => l.price))
    .filter((z) => z.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, SR_MAX_LEVELS);
  return { support, resistance };
}

export function analyzeStructure(candles, { lookback = 200 } = {}) {
  const recent = (candles || []).slice(-lookback).filter((c) => Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
  if (recent.length < PIVOT_LOOKBACK * 2 + 4) {
    return { trend: 'undefined', signal: null, supportResistance: { support: [], resistance: [] }, pivotCount: 0 };
  }
  const { highs, lows } = findPivots(recent);
  const trend = classifyTrend(highs, lows);
  const signal = classifySignal(recent, highs, lows);
  const supportResistance = nearestLevels(recent, highs, lows);
  return {
    trend, signal, supportResistance,
    pivotCount: highs.length + lows.length,
    swingHighs: highs.slice(-4).map((h) => ({ time: h.time, price: round(h.price) })),
    swingLows: lows.slice(-4).map((l) => ({ time: l.time, price: round(l.price) }))
  };
}
