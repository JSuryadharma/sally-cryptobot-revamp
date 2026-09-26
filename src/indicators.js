// Adapted from robotrader's src/indicators.js (same math, MIT-style internal reuse
// within this user's own two projects). Extended to also expose the extra EMA spans
// (9/20/21/50) and the 7-period RSI that robocrypto's swing/scalping/day-trade
// strategies need, and to export the ema()/rsi() helpers directly so decisionEngine.js
// can be explicit about which line it's reading instead of guessing field names.

export function enrichCandles(candles) {
  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const closes = sorted.map((candle) => candle.close);
  const highs = sorted.map((candle) => candle.high);
  const lows = sorted.map((candle) => candle.low);
  const volumes = sorted.map((candle) => candle.volume || 0);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const volumeSma20 = sma(volumes, 20);
  const ema9 = ema(closes, 9);
  const ema12 = ema(closes, 12);
  const ema20 = ema(closes, 20);
  const ema21 = ema(closes, 21);
  const ema26 = ema(closes, 26);
  const ema50 = ema(closes, 50);
  const macd = closes.map((_, index) => (valueOrNull(ema12[index]) === null || valueOrNull(ema26[index]) === null) ? null : ema12[index] - ema26[index]);
  const macdSignal = ema(macd, 9);
  const macdHistogram = macd.map((value, index) => (valueOrNull(value) === null || valueOrNull(macdSignal[index]) === null) ? null : value - macdSignal[index]);
  const rsi7 = rsi(closes, 7);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(sorted, 14);
  const bollinger = bollingerBands(closes, 20, 2);
  const directional = adx(sorted, 14);

  return sorted.map((candle, index) => ({
    ...candle,
    change: index === 0 ? null : round(candle.close - sorted[index - 1].close),
    changePct: index === 0 ? null : round(((candle.close - sorted[index - 1].close) / sorted[index - 1].close) * 100),
    sma20: roundOrNull(sma20[index]),
    sma50: roundOrNull(sma50[index]),
    volumeSma20: roundOrNull(volumeSma20[index]),
    ema9: roundOrNull(ema9[index]),
    ema12: roundOrNull(ema12[index]),
    ema20: roundOrNull(ema20[index]),
    ema21: roundOrNull(ema21[index]),
    ema26: roundOrNull(ema26[index]),
    ema50: roundOrNull(ema50[index]),
    macd: roundOrNull(macd[index]),
    macdSignal: roundOrNull(macdSignal[index]),
    macdHistogram: roundOrNull(macdHistogram[index]),
    rsi7: roundOrNull(rsi7[index]),
    rsi14: roundOrNull(rsi14[index]),
    atr14: roundOrNull(atr14[index]),
    atrPct: valueOrNull(atr14[index]) === null ? null : round((atr14[index] / candle.close) * 100),
    bbMiddle: roundOrNull(bollinger.middle[index]),
    bbUpper: roundOrNull(bollinger.upper[index]),
    bbLower: roundOrNull(bollinger.lower[index]),
    adx14: roundOrNull(directional.adx[index]),
    plusDI14: roundOrNull(directional.plusDI[index]),
    minusDI14: roundOrNull(directional.minusDI[index])
  }));
}

export function ema(values, period) {
  const output = Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let previous = null;
  const seed = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isFiniteNumber(value)) { output[index] = previous; continue; }
    if (previous === null) {
      seed.push(value);
      if (seed.length === period) {
        previous = seed.reduce((sum, item) => sum + item, 0) / period;
        output[index] = previous;
      }
      continue;
    }
    previous = (value - previous) * multiplier + previous;
    output[index] = previous;
  }
  return output;
}

export function rsi(values, period) {
  const output = Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (index === period) {
        avgGain /= period;
        avgLoss /= period;
        output[index] = rsiFromAverages(avgGain, avgLoss);
      }
      continue;
    }
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    output[index] = rsiFromAverages(avgGain, avgLoss);
  }
  return output;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function sma(values, period) {
  const output = Array(values.length).fill(null);
  let sum = 0;
  let finiteCount = 0;
  const queue = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    queue.push(value);
    if (isFiniteNumber(value)) { sum += value; finiteCount += 1; }
    if (queue.length > period) {
      const removed = queue.shift();
      if (isFiniteNumber(removed)) { sum -= removed; finiteCount -= 1; }
    }
    if (queue.length === period && finiteCount === period) output[index] = sum / period;
  }
  return output;
}

function atr(candles, period) {
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return sma(trueRanges, period);
}

// Wilder's ADX - trend STRENGTH, not direction. >=25 with +DI>-DI is a genuine
// trend worth swinging; <20 reads range-bound/choppy, where a crossover system
// whipsaws - this is the main input to robocrypto's swing/scalp/day-trade picker.
function adx(candles, period) {
  const length = candles.length;
  const trueRanges = Array(length).fill(null);
  const plusDM = Array(length).fill(null);
  const minusDM = Array(length).fill(null);
  for (let index = 1; index < length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    if (![current.high, current.low, previous.high, previous.low, previous.close].every(isFiniteNumber)) continue;
    trueRanges[index] = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDM[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[index] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const smoothedTR = wilderSmooth(trueRanges, period);
  const smoothedPlusDM = wilderSmooth(plusDM, period);
  const smoothedMinusDM = wilderSmooth(minusDM, period);
  const plusDI = Array(length).fill(null);
  const minusDI = Array(length).fill(null);
  const dx = Array(length).fill(null);
  for (let index = 0; index < length; index += 1) {
    const tr = smoothedTR[index];
    if (!isFiniteNumber(tr) || tr === 0) continue;
    const pdi = isFiniteNumber(smoothedPlusDM[index]) ? (smoothedPlusDM[index] / tr) * 100 : null;
    const mdi = isFiniteNumber(smoothedMinusDM[index]) ? (smoothedMinusDM[index] / tr) * 100 : null;
    plusDI[index] = pdi;
    minusDI[index] = mdi;
    if (isFiniteNumber(pdi) && isFiniteNumber(mdi) && pdi + mdi > 0) {
      dx[index] = (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
    }
  }
  const adxLine = wilderSmooth(dx, period, true);
  return { adx: adxLine, plusDI, minusDI };
}

function wilderSmooth(values, period, isAverage = false) {
  const output = Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  let smoothed = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (smoothed === null) {
      if (isFiniteNumber(value)) { sum += value; count += 1; }
      if (count === period) { smoothed = isAverage ? sum / period : sum; output[index] = smoothed; }
      continue;
    }
    if (!isFiniteNumber(value)) { output[index] = smoothed; continue; }
    smoothed = isAverage ? ((smoothed * (period - 1)) + value) / period : smoothed - (smoothed / period) + value;
    output[index] = smoothed;
  }
  return output;
}

function bollingerBands(values, period, deviationMultiplier) {
  const middle = sma(values, period);
  const upper = Array(values.length).fill(null);
  const lower = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const mean = middle[index];
    const variance = window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / period;
    const deviation = Math.sqrt(variance);
    upper[index] = mean + deviation * deviationMultiplier;
    lower[index] = mean - deviation * deviationMultiplier;
  }
  return { middle, upper, lower };
}

function isFiniteNumber(value) { return Number.isFinite(value); }
function valueOrNull(value) { return isFiniteNumber(value) ? value : null; }
function roundOrNull(value) { return isFiniteNumber(value) ? round(value) : null; }
// Significant digits, not fixed decimals: a fixed 4-decimal round erased ATR
// and EMA precision on sub-$0.10 coins (e.g. a DOGE 15m ATR of 0.00049 -> 0.0005).
function round(value) { return value === 0 ? 0 : Number(value.toPrecision(10)); }
