// Candle helpers shared by the engine loop (core.js) and the strategy modules
// (strategies/*.js). Pure.
import { TF_MS } from './config.js';

export function closeMsOf(bar, tf) {
  return bar.time * 1000 + TF_MS[tf];
}

// Index of the last bar in `bars` closed at or before `ms`, or -1.
export function lastClosedIndex(bars, tf, ms) {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMsOf(bars[mid], tf) <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Index of the first bar opened after `time`, or -1. Binary search: the
// backtest's autopilot replay calls advance() once per day.
export function firstAfter(bars, time) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time > time) hi = mid; else lo = mid + 1;
  }
  return lo < bars.length ? lo : -1;
}

export function symbolState(state, symbol) {
  if (!state.symbols[symbol]) state.symbols[symbol] = { lastBarTime: {}, cooldownUntilMs: {} };
  const s = state.symbols[symbol];
  s.lastBarTime ||= {};
  s.cooldownUntilMs ||= {};
  return s;
}

// The trigger-timeframe candle formed so far, from the closed early candles
// since it opened up to and including sub[k].
export function formingCandle(sub, k, tf) {
  const openMs = Math.floor((sub[k].time * 1000) / TF_MS[tf]) * TF_MS[tf];
  let m = k;
  while (m > 0 && sub[m - 1].time * 1000 >= openMs) m -= 1;
  const bar = { time: openMs / 1000, date: new Date(openMs).toISOString().slice(0, 10), open: sub[m].open, high: -Infinity, low: Infinity, close: sub[k].close, volume: 0 };
  for (let n = m; n <= k; n += 1) {
    bar.high = Math.max(bar.high, sub[n].high);
    bar.low = Math.min(bar.low, sub[n].low);
    bar.volume += sub[n].volume || 0;
  }
  return bar;
}

export function priorHighOf(daily, endIdx, n) {
  let high = -Infinity;
  for (let k = endIdx - n + 1; k <= endIdx; k += 1) high = Math.max(high, daily[k].high);
  return high;
}

export function roundPx(value) {
  return Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(8)) : value;
}
