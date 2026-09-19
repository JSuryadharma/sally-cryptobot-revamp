// Entry/exit variants from the 2026-09 revamp benchmark ladder (see the
// delivered PDF report: "Robocrypto Revamp - Backtest & Changes Report").
// This file never touches decisionEngine.js's own evaluateEntry/evaluateExit
// - it reuses their STRATEGY_PARAMS/ADX_TREND_FLOOR/computeConfidencePct/
// roundToTick math directly, and is additive: decisionEngine.js's original
// functions are still exported and still used by describeNearCondition/the
// manual-buy button/anything that wants the plain baseline behavior.
//
// Two changes vs. the sandbox benchmark harness this was developed in
// (scripts/systemBenchmark.mjs in the bt/ sandbox):
//   1. This trimmed version keeps only what the shipped ladder (v2/v3/v6)
//      actually uses - the abandoned "reactive 3-parameter confidence" and
//      "EMA cross window" experiments (both found harmful in benchmarking)
//      are left out of production code.
//   2. The stateful retest/structure logic here is wrapped by
//      src/liveStrategy.js with a bar-dedup guard before being called from
//      robotEngine.js, because the live app can be refreshed many times
//      within a single candle's lifetime (a ~5-minute cron plus a 30s UI
//      poll), unlike the benchmark harness's fixed 15-minute simulated tick.
//      Without that guard, "wait one more bar to confirm a spike" or "wait
//      up to 6 bars for a retest" would resolve in seconds instead of real
//      candle closes. See liveStrategy.js for the guard itself.

import { STRATEGY_PARAMS, ADX_TREND_FLOOR, computeConfidencePct } from './decisionEngine.js';

export const RETEST_WINDOW_BARS = 6;
export const SWING_LOOKBACK = 6; // retuned from the original 3-bar lookback - see v3 in the revamp report

function finite(...values) { return values.every((v) => Number.isFinite(v)); }

function roundToTick(value) {
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 2 : magnitude >= 1 ? 4 : magnitude >= 0.01 ? 6 : 8;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tpAtrMultFor(params, rrMultiple) {
  return params.slAtrMult * (Number.isFinite(rrMultiple) ? rrMultiple : params.tpAtrMult / params.slAtrMult);
}

function buildBuyResult(curr, mode, reason, confidencePct, rrMultiple) {
  const params = STRATEGY_PARAMS[mode];
  const atr = curr.atr14;
  const hasAtr = Number.isFinite(atr) && atr > 0;
  const tpAtrMult = tpAtrMultFor(params, rrMultiple);
  return {
    action: 'BUY',
    reason,
    confidencePct,
    entryPrice: curr.close,
    stopPrice: hasAtr ? roundToTick(curr.close - atr * params.slAtrMult) : null,
    targetPrice: hasAtr ? roundToTick(curr.close + atr * tpAtrMult) : null,
    maxHoldUntil: new Date(curr.time * 1000 + params.maxHoldBars * params.barMs).toISOString()
  };
}

// --- raw signal detectors: "did a fresh trigger condition occur on THIS bar?" ---
// Both return { fired, level (the price level to retest), rsiOk, adxOk } so
// the retest gate can share one shape across either trigger type.

export function detectEmaCross(candles, mode) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles.at(-1);
  const prev = candles.at(-2);
  if (!curr || !prev) return { fired: false };
  const fastNow = curr[params.fastKey], slowNow = curr[params.slowKey];
  const fastPrev = prev[params.fastKey], slowPrev = prev[params.slowKey];
  if (!finite(fastNow, slowNow, fastPrev, slowPrev)) return { fired: false };
  const crossed = fastPrev <= slowPrev && fastNow > slowNow;
  const rsiVal = curr[params.rsiKey];
  const rsiOk = Number.isFinite(rsiVal) && (params.rsiFloor === undefined || rsiVal >= params.rsiFloor) && (params.rsiCeiling === undefined || rsiVal <= params.rsiCeiling);
  const adxOk = Number.isFinite(curr.adx14) && curr.adx14 >= ADX_TREND_FLOOR;
  return { fired: crossed, level: slowNow, rsiOk, adxOk, rsiVal, adxVal: curr.adx14 };
}

// Breakout: latest CLOSE is beyond the upper band, and the previous close was
// not - the same "single fresh bar" precision the EMA cross uses.
export function detectBollingerBreakout(candles) {
  const curr = candles.at(-1);
  const prev = candles.at(-2);
  if (!curr || !prev) return { fired: false };
  if (!finite(curr.bbUpper, curr.close, prev.bbUpper, prev.close)) return { fired: false };
  const fresh = prev.close <= prev.bbUpper && curr.close > curr.bbUpper;
  return { fired: fresh, level: curr.bbUpper, rsiOk: true, adxOk: true };
}

// --- retest gate: stateful, called once per bar per (symbol, mode) with a
// small object the caller persists between bars.
//
// "Retest" definition (a judgment call, stated explicitly): a raw signal on
// bar N arms a pending trigger level (the slow EMA, or the band edge) rather
// than buying immediately. Over the next RETEST_WINDOW_BARS bars, the first
// bar whose LOW touches-or-passes the level while its CLOSE still holds
// above it is the actual entry, at that bar's close. A bar that instead
// CLOSES back below the level invalidates the setup. No qualifying bar
// within the window expires it - a real, accepted cost: a strategy that
// always waits for a retest will always miss a trend that never pulls back.
export function makeRetestState() {
  return { armed: false, level: null, barsWaited: 0 };
}

export function evaluateEntryWithRetest(candles, mode, detectFn, state, { rrMultiple, confidenceFn = computeConfidencePct } = {}) {
  const curr = candles.at(-1);
  const confidencePct = confidenceFn(candles, mode);
  if (!curr) return { action: 'HOLD', reason: 'no data', confidencePct };

  if (!state.armed) {
    const sig = detectFn(candles, mode);
    if (sig.fired && sig.rsiOk && sig.adxOk) {
      state.armed = true;
      state.level = sig.level;
      state.barsWaited = 0;
      return { action: 'HOLD', reason: `signal armed at ${sig.level}, waiting for retest`, confidencePct };
    }
    return { action: 'HOLD', reason: 'no fresh signal', confidencePct };
  }

  state.barsWaited += 1;
  const retested = curr.low <= state.level;
  const held = curr.close >= state.level;

  if (retested && held) {
    const reason = `retest held at ${state.level} (waited ${state.barsWaited} bar${state.barsWaited === 1 ? '' : 's'})`;
    state.armed = false; state.level = null; state.barsWaited = 0;
    return buildBuyResult(curr, mode, reason, confidencePct, rrMultiple);
  }
  if (curr.close < state.level) {
    state.armed = false; state.level = null; state.barsWaited = 0;
    return { action: 'HOLD', reason: `retest failed - closed back below ${state.level}, signal discarded`, confidencePct };
  }
  if (state.barsWaited >= RETEST_WINDOW_BARS) {
    state.armed = false; state.level = null; state.barsWaited = 0;
    return { action: 'HOLD', reason: `no retest within ${RETEST_WINDOW_BARS} bars - signal expired`, confidencePct };
  }
  return { action: 'HOLD', reason: `armed at ${state.level}, waiting for retest (${state.barsWaited}/${RETEST_WINDOW_BARS})`, confidencePct };
}

// --- combined entry: EMA-retest OR BB-retest, whichever confirms first -----
// Two independent retest state machines run side by side on the same
// (symbol, mode); whichever completes its retest first fires the BUY. If
// both would complete on the exact same bar (rare), EMA is checked first -
// an arbitrary but harmless tie-break since only one trade can be taken.
export function makeCombinedEntryState() {
  return { ema: makeRetestState(), bb: makeRetestState() };
}

export function evaluateEntryCombinedRetest(candles, mode, state, opts = {}) {
  const emaResult = evaluateEntryWithRetest(candles, mode, detectEmaCross, state.ema, opts);
  if (emaResult.action === 'BUY') return emaResult;
  const bbResult = evaluateEntryWithRetest(candles, mode, detectBollingerBreakout, state.bb, opts);
  if (bbResult.action === 'BUY') return bbResult;
  return emaResult.reason?.startsWith('armed') || emaResult.reason?.startsWith('signal') ? emaResult : bbResult;
}

// --- market structure (Break of Structure / Change of Character) ----------
// A confirmed fractal pivot: bar i's high (low) is strictly the highest
// (lowest) among the SWING_LOOKBACK bars on either side of it. Runs causally
// (no lookahead) - a pivot is only confirmed SWING_LOOKBACK bars after it.
//
// Change of Character (CHoCH): price CLOSES below the most recently
// confirmed swing LOW - the higher-lows pattern that defined an uptrend has
// broken. Used below as the trend-exit trigger for a long position, in place
// of (or alongside) a plain fast-EMA-crossed-back-below-slow-EMA exit.
export function makeStructureState() {
  return { lastSwingHigh: null, lastSwingLow: null, lastBosAt: null };
}

function updateStructure(state, candles, lookback = SWING_LOOKBACK) {
  const n = candles.length;
  const pivotIdx = n - 1 - lookback;
  const windowStart = pivotIdx - lookback;
  const windowEnd = pivotIdx + lookback;
  if (windowStart < 0 || windowEnd >= n) return;
  const pivot = candles[pivotIdx];
  if (!finite(pivot.high, pivot.low)) return;
  let isSwingHigh = true, isSwingLow = true;
  for (let j = windowStart; j <= windowEnd; j += 1) {
    if (j === pivotIdx) continue;
    const c = candles[j];
    if (!finite(c.high, c.low)) { isSwingHigh = false; isSwingLow = false; break; }
    if (c.high >= pivot.high) isSwingHigh = false;
    if (c.low <= pivot.low) isSwingLow = false;
  }
  if (isSwingHigh) {
    if (state.lastSwingHigh && pivot.high > state.lastSwingHigh.price) state.lastBosAt = pivot.time;
    state.lastSwingHigh = { price: pivot.high, time: pivot.time };
  }
  if (isSwingLow) {
    state.lastSwingLow = { price: pivot.low, time: pivot.time };
  }
}

function checkChoch(state, candles) {
  const curr = candles.at(-1);
  if (!state.lastSwingLow || !finite(curr.close)) return false;
  return curr.close < state.lastSwingLow.price;
}

// --- spike-aware, structure-exit variant of evaluateExit -------------------
// Two changes from decisionEngine.js's live evaluateExit:
//
//   useChoch (default true) - trend exit fires on CHoCH instead of "fast EMA
//     crossed back below slow EMA."
//
//   spikeAtrMult (default 1.0) - a stop-loss breach deeper than this many
//     ATRs past the stop price is treated as a SPIKE, not an ordinary
//     stop-touch, and is given one more bar to prove the breakdown is real
//     before exiting - direct response to a real ASTRUSDT trade (-Rp
//     260,365) where a single 15-minute candle's close landed 2.6% past a
//     6%-wide ATR stop on a highly volatile low-cap coin. Honest tradeoff:
//     this only helps on average if most extreme single-candle breaches
//     partially revert - on a genuine sustained breakdown, waiting one extra
//     bar can realize a WORSE loss than exiting immediately would have.
export function makeStructuredExitState() {
  return { structure: makeStructureState(), pendingSpikeStop: null };
}

export function evaluateExitStructured(candles, position, mode, state, { nowMs, useChoch = true, spikeAtrMult = 1.0, structureCandles, swingLookback = SWING_LOOKBACK } = {}) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles.at(-1);
  const prev = candles.at(-2);
  const confidencePct = computeConfidencePct(candles, mode);
  if (!curr) return { action: 'HOLD', reason: 'No price data.', confidencePct };
  const price = curr.close;
  const effectiveNowMs = nowMs ?? Date.now();

  // Higher-timeframe alignment: track structure on the daily/swing candles
  // when supplied, rather than this position's own (often noisier) trading
  // timeframe - the fix external SMC-backtest research pointed at (and this
  // session's own 6-month backtest confirmed) after a same-timeframe,
  // 3-bar-lookback version proved too twitchy on 15m/1h. Falls back to the
  // position's own candles if none is supplied.
  const structSource = structureCandles && structureCandles.length ? structureCandles : candles;
  updateStructure(state.structure, structSource, swingLookback);

  // Ratchet the trailing stop - identical mechanics to decisionEngine.js's evaluateExit.
  const priorHigh = Number.isFinite(position.highWaterMark) ? position.highWaterMark : position.entryPrice;
  const highWaterMark = Math.max(priorHigh, Number.isFinite(curr.high) ? curr.high : price);
  let stopPrice = Number.isFinite(position.stopPrice) ? position.stopPrice : null;
  if (Number.isFinite(curr.atr14) && curr.atr14 > 0 && Number.isFinite(highWaterMark)) {
    const trailingCandidate = roundToTick(highWaterMark - curr.atr14 * params.slAtrMult);
    stopPrice = Number.isFinite(stopPrice) ? Math.max(stopPrice, trailingCandidate) : trailingCandidate;
  }
  const trailed = Number.isFinite(position.stopPrice) && Number.isFinite(stopPrice) && stopPrice > position.stopPrice;

  if (Number.isFinite(stopPrice) && price <= stopPrice) {
    const breachAtr = Number.isFinite(curr.atr14) && curr.atr14 > 0 ? (stopPrice - price) / curr.atr14 : 0;
    const isSpike = breachAtr > spikeAtrMult;
    if (isSpike && !state.pendingSpikeStop) {
      state.pendingSpikeStop = stopPrice;
      return {
        action: 'HOLD',
        reason: `Stop breached by ${breachAtr.toFixed(2)}x ATR (spike threshold ${spikeAtrMult}x) - treating as a spike, waiting one bar to confirm before exiting.`,
        confidencePct, highWaterMark, stopPrice
      };
    }
    state.pendingSpikeStop = null;
    return {
      action: 'SELL',
      reason: `${trailed ? 'Trailing stop' : 'Stop-loss'} hit at ${price} (stop was ${stopPrice}).`,
      confidencePct, highWaterMark, stopPrice
    };
  }
  state.pendingSpikeStop = null;

  if (Number.isFinite(position.targetPrice) && price >= position.targetPrice) {
    return { action: 'SELL', reason: `Take-profit hit at ${price} (target was ${position.targetPrice}).`, confidencePct, highWaterMark, stopPrice };
  }
  if (position.maxHoldUntil && effectiveNowMs >= new Date(position.maxHoldUntil).getTime()) {
    return { action: 'SELL', reason: `Max hold window (${params.maxHoldBars} bars) elapsed - exiting on time, not signal.`, confidencePct, highWaterMark, stopPrice };
  }

  if (useChoch) {
    if (checkChoch(state.structure, structSource)) {
      return { action: 'SELL', reason: `CHoCH: close broke below the last confirmed swing low at ${state.structure.lastSwingLow.price} (higher-timeframe structure).`, confidencePct, highWaterMark, stopPrice };
    }
  } else if (prev) {
    const fastNow = curr[params.fastKey], slowNow = curr[params.slowKey];
    const fastPrev = prev[params.fastKey], slowPrev = prev[params.slowKey];
    if (finite(fastNow, slowNow, fastPrev, slowPrev) && fastPrev >= slowPrev && fastNow < slowNow) {
      return { action: 'SELL', reason: `Trend exit: ${params.fastKey.toUpperCase()} crossed back below ${params.slowKey.toUpperCase()}.`, confidencePct, highWaterMark, stopPrice };
    }
  }

  return {
    action: 'HOLD',
    reason: trailed ? `Trailing stop raised to ${stopPrice} (was ${position.stopPrice}).` : 'Position within plan - holding.',
    confidencePct, highWaterMark, stopPrice
  };
}

// --- direction filter: separate, slow trend gate ---------------------------
// decisionEngine.js's live entry fuses DIRECTION and TIMING into the same
// fast EMA cross - there's no independent, slower check that the broader
// trend actually agrees before that fast cross is allowed to fire. This adds
// exactly that and nothing else: it never generates a BUY by itself, it only
// blocks one. Definition: daily CLOSE above daily EMA50 - the slowest,
// most stable signal already available from indicators.js.
export function checkDirectionFilter(dailySnap) {
  const curr = dailySnap?.latest;
  if (!curr || !finite(curr.close, curr.ema50)) {
    return { ok: true, reason: 'direction filter: insufficient daily data, not blocking' };
  }
  const ok = curr.close > curr.ema50;
  return {
    ok,
    reason: ok
      ? `direction filter OK: daily close ${curr.close} above daily EMA50 ${curr.ema50.toFixed(6)}`
      : `direction filter blocked: daily close ${curr.close} below daily EMA50 ${curr.ema50.toFixed(6)} - no new longs regardless of what the faster timeframe shows`
  };
}

// Wraps the combined EMA-retest/BB-retest entry with the direction filter
// above. dailySnap is the SWING (daily) snapshot, passed in regardless of
// which mode the position would actually trade on - direction is checked on
// the higher timeframe on purpose, never on the same fast candles as the
// entry trigger itself.
export function evaluateEntryCombinedRetestDirectionGated(candles, mode, dailySnap, state, opts = {}) {
  const direction = checkDirectionFilter(dailySnap);
  if (!direction.ok) {
    return { action: 'HOLD', reason: direction.reason, confidencePct: 0 };
  }
  return evaluateEntryCombinedRetest(candles, mode, state, opts);
}
