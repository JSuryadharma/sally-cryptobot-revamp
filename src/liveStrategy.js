// Bar-dedup wrapper around triggerVariants.js's stateful entry/exit
// functions, for use from robotEngine.js.
//
// Why this exists: the benchmark harness this strategy was tuned in
// (scripts/systemBenchmark.mjs) advances its retest/structure state exactly
// once per distinct candle - its simulated tick (15 minutes) never runs
// faster than its fastest timeframe (scalping, also 15 minutes), so "wait up
// to 6 bars for a retest" or "wait one more bar to confirm a spike" always
// meant real candle closes. The live app has no such guarantee: it's
// refreshed by a ~5-minute GitHub Actions cron AND a 30-second UI poll, both
// far more often than an hourly (dayTrade) or daily (swing) candle closes.
// Calling the stateful functions on every refresh without a guard would let
// "one more bar" resolve in 30 seconds instead of a real bar, and would
// double-count retest bars, silently making the strategy far twitchier than
// what was actually benchmarked.
//
// The fix: only advance the stateful logic when the relevant candle series'
// latest timestamp has actually changed since the last call for that
// (symbol, mode) key; otherwise replay the last computed result untouched.
// Since closedCandles (see marketData.js) only changes when a new bar
// closes, this exactly reproduces "once per real bar," regardless of how
// often refreshSymbol/refreshAll happens to be called in between.
import {
  makeCombinedEntryState, makeStructuredExitState,
  evaluateEntryCombinedRetestDirectionGated, evaluateExitStructured
} from './triggerVariants.js';

export function evaluateLiveEntry(entryState, key, candles, mode, dailySnap, opts = {}) {
  const currTime = candles?.at(-1)?.time ?? null;
  if (!entryState[key]) entryState[key] = { combined: makeCombinedEntryState(), lastBarTime: null, lastResult: null };
  const slot = entryState[key];
  if (currTime != null && slot.lastBarTime === currTime && slot.lastResult) {
    return slot.lastResult;
  }
  const result = evaluateEntryCombinedRetestDirectionGated(candles, mode, dailySnap, slot.combined, opts);
  slot.lastBarTime = currTime;
  slot.lastResult = result;
  return result;
}

export function evaluateLiveExit(exitState, key, candles, position, mode, structureCandles, opts = {}) {
  const currTime = candles?.at(-1)?.time ?? null;
  if (!exitState[key]) exitState[key] = { structured: makeStructuredExitState(), lastBarTime: null, lastResult: null };
  const slot = exitState[key];
  if (currTime != null && slot.lastBarTime === currTime && slot.lastResult) {
    return slot.lastResult;
  }
  const result = evaluateExitStructured(candles, position, mode, slot.structured, { ...opts, structureCandles });
  slot.lastBarTime = currTime;
  slot.lastResult = result;
  return result;
}
