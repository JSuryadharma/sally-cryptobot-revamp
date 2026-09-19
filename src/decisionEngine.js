// Applies the exact three trading systems backtested earlier this session on
// one year of real BBCA and BTC/USDT data (see the Word report + CSV trade
// logs already delivered): an EMA-cross entry, an RSI filter, and an
// ATR-sized stop/target with a time-based max hold. Swing and scalping here
// use the identical parameters that were backtested; day-trade is a new
// third mode at an in-between timeframe (1h candles), built the same way but
// not separately backtested - see README for that caveat.
//
// Honest framing, carried over from the backtest report: every one of these
// three systems came out net-negative over the last year once realistic
// costs were included. They are shipped anyway because the point of this
// app is to watch the *process* (position sizing, discipline, journal) run
// continuously on live data, not because this is a proven money-maker.
// The dashboard should not be read as investment advice.

export const STRATEGY_PARAMS = {
  swing: {
    label: 'Swing (EMA20/50, daily)',
    fastKey: 'ema20', slowKey: 'ema50', rsiKey: 'rsi14',
    rsiCeiling: 75,
    maxHoldBars: 20, barMs: 24 * 60 * 60_000, // 20 daily candles
    slAtrMult: 1.8, tpAtrMult: 3.6 // default = the exact backtested 2:1 target
  },
  scalping: {
    label: 'Scalping (EMA9/21, 15m)',
    fastKey: 'ema9', slowKey: 'ema21', rsiKey: 'rsi7',
    rsiFloor: 50, rsiCeiling: 70, // reverted to the originally-backtested 50-70 band (2026-09-19) - the 2026-09-12 widening to 30 was never separately backtested and this session's ladder benchmark found it did not pay for itself; see the revamp report.
    maxHoldBars: 8, barMs: 15 * 60_000, // 8 x 15m = 2 hours
    slAtrMult: 1.5, tpAtrMult: 3.0
  },
  dayTrade: {
    label: 'Day-trade (EMA9/21, 1h)',
    fastKey: 'ema9', slowKey: 'ema21', rsiKey: 'rsi14',
    rsiFloor: 45, rsiCeiling: 75,
    maxHoldBars: 16, barMs: 60 * 60_000, // 16 hours - closes out same-to-next day
    slAtrMult: 1.6, tpAtrMult: 3.2
  }
};

// User-facing take-profit/stop-loss "risk template" - the stop distance
// stays at each mode's own backtested ATR multiple (that's what was
// calibrated against real volatility), only the reward side scales with it,
// so "balanced" reproduces the exact backtested 2:1 ratio and the other two
// templates are honest variations on top of it, not an untested guess.
// Wilder's own "a trend actually exists" threshold - shared by evaluateEntry (the hard entry gate)
// and describeNearCondition (the UI's "how close" readout), so the two can never drift out of sync the
// way two separately-hardcoded local constants could.
export const ADX_TREND_FLOOR = 20;

export const RR_TEMPLATES = {
  conservative: { label: 'Conservative', ratio: 1.5, description: 'Tighter target, exits sooner - fewer big winners but a higher hit rate.' },
  balanced: { label: 'Balanced (backtested default)', ratio: 2, description: 'The exact 2:1 reward:risk used in the swing/scalping backtest.' },
  aggressive: { label: 'Aggressive', ratio: 3, description: 'Wider target, holds out for a bigger win - lower hit rate, bigger payoff when right.' }
};

function finite(...values) {
  return values.every((v) => Number.isFinite(v));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function tpAtrMultFor(params, rrMultiple) {
  return params.slAtrMult * (Number.isFinite(rrMultiple) ? rrMultiple : params.tpAtrMult / params.slAtrMult);
}

// 0-100: how much the current technical setup actually agrees with the
// direction the strategy is watching, independent of whether a trade signal
// has fired yet. Four ingredients, each already computed by indicators.js:
//   - EMA conviction relative to ATR: the max of (a) how wide the fast/slow
//     gap already is, relative to current volatility - a proxy for an
//     established trend even with no fresh cross - and (b) how fast that gap
//     is currently widening, relative to volatility - a proxy for a sharp,
//     high-conviction cross where absolute separation is still small. Using
//     only (a) meant this term was structurally near-zero at the exact bar
//     evaluateEntry can fire a BUY (a fresh cross has, by definition, almost
//     no separation yet), which measurably capped every real signal below a
//     55% default threshold across real BTC/ETH/BNB/SOL/XRP history - see
//     scripts/benchmark.mjs. Taking the max of both keeps that term honest
//     in both situations instead of only the first.
//   - RSI centered in its confirmation band rather than pinned at an edge
//     (an RSI sitting right at the floor/ceiling is one tick from failing).
//   - ADX: is there a trend worth trading at all, or is this a flat market
//     where any crossover is close to a coin flip?
//   - +DI/-DI agreement: is directional movement actually confirming the
//     same bias the EMA cross implies?
// This is a transparent, rule-based confidence score - not a probability of
// winning the trade, and not backtested as a standalone predictor. Treat it
// as "how textbook does this setup look right now," nothing more.
export function computeConfidencePct(candles, mode) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles?.at(-1);
  const prev = candles?.at(-2);
  if (!curr) return 0;
  const parts = [];

  const fast = curr[params.fastKey];
  const slow = curr[params.slowKey];
  if (finite(fast, slow, curr.close, curr.atr14) && curr.atr14 > 0) {
    const atrPct = (curr.atr14 / curr.close) * 100;
    const gapPct = (Math.abs(fast - slow) / curr.close) * 100;
    const establishedTerm = clamp01(gapPct / (atrPct * 1.5 || 1));
    let velocityTerm = 0;
    const fastPrev = prev?.[params.fastKey];
    const slowPrev = prev?.[params.slowKey];
    if (finite(fastPrev, slowPrev)) {
      const velocityPct = (((fast - slow) - (fastPrev - slowPrev)) / curr.close) * 100;
      velocityTerm = clamp01(velocityPct / (atrPct * 0.5 || 1));
    }
    parts.push({ weight: 0.35, value: Math.max(establishedTerm, velocityTerm) });
  }

  const rsiVal = curr[params.rsiKey];
  // 0/100 = "no filter", matching evaluateEntry's own rule (params.rsiFloor/rsiCeiling === undefined
  // means that side is never gated) - previously defaulted to 30/70, which invented a floor for swing
  // mode (the only STRATEGY_PARAMS entry with no rsiFloor) that the real entry rule doesn't enforce,
  // silently penalizing confidence for low-RSI swing setups the gate would have allowed through.
  const floor = params.rsiFloor ?? 0;
  const ceiling = params.rsiCeiling ?? 100;
  if (Number.isFinite(rsiVal)) {
    const mid = (floor + ceiling) / 2;
    const halfWidth = (ceiling - floor) / 2 || 1;
    parts.push({ weight: 0.25, value: 1 - clamp01(Math.abs(rsiVal - mid) / halfWidth) });
  }

  if (Number.isFinite(curr.adx14)) {
    parts.push({ weight: 0.25, value: clamp01(curr.adx14 / 40) });
  }

  if (finite(curr.plusDI14, curr.minusDI14) && curr.plusDI14 + curr.minusDI14 > 0) {
    const diBias = (curr.plusDI14 - curr.minusDI14) / (curr.plusDI14 + curr.minusDI14); // -1..+1
    parts.push({ weight: 0.15, value: clamp01((diBias + 1) / 2) });
  }

  if (!parts.length) return 0;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = parts.reduce((sum, p) => sum + p.weight * p.value, 0) / totalWeight;
  return Math.round(score * 100);
}

// No open position: is this the bar where the fast EMA just crossed above the
// slow EMA, with RSI confirming there's live bullish momentum (not just a
// stale cross)? Long-only, same as the backtest - shorting isn't modelled.
// `rrMultiple` lets the caller apply the user's chosen risk template (see
// RR_TEMPLATES above); omit it to fall back to the mode's own backtested ratio.
export function evaluateEntry(candles, mode, { rrMultiple } = {}) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles.at(-1);
  const prev = candles.at(-2);
  const confidencePct = computeConfidencePct(candles, mode);
  if (!curr || !prev) return { action: 'HOLD', reason: 'Not enough candles yet.', confidencePct };

  const fastNow = curr[params.fastKey];
  const slowNow = curr[params.slowKey];
  const fastPrev = prev[params.fastKey];
  const slowPrev = prev[params.slowKey];
  if (!finite(fastNow, slowNow, fastPrev, slowPrev)) {
    return { action: 'HOLD', reason: 'Indicators still warming up on this symbol.', confidencePct };
  }

  const bullishCross = fastPrev <= slowPrev && fastNow > slowNow;
  const rsiVal = curr[params.rsiKey];
  const rsiOk = Number.isFinite(rsiVal)
    && (params.rsiFloor === undefined || rsiVal >= params.rsiFloor)
    && (params.rsiCeiling === undefined || rsiVal <= params.rsiCeiling);
  // Wilder's own "a trend actually exists" threshold - already documented in
  // indicators.js's adx() comment ("<20 reads range-bound/choppy, where a
  // crossover system whipsaws") but never enforced as a hard gate before this.
  // Validated on 1 year of real BTC/ETH/BNB/SOL/XRP/ADA/DOGE/AVAX data, split
  // into two independent halves so a lucky spike in one period couldn't hide
  // behind the aggregate: adding this floor alone improved BOTH halves versus
  // no filter (H1 -1.18% -> -0.96%, H2 +2.07% -> +3.64%; full year +0.87% ->
  // +2.64%, profit factor 1.04 -> 1.19, 77 -> 61 trades - still comfortably
  // above the 30-trade minimum). A paired +DI/-DI direction check and a
  // volume-above-average check were also tried and neither improved on ADX
  // alone (DI was redundant with the cross itself; volume was inconsistent
  // across the two halves) - see reports/system-technical-analysis-2026-09-05.md.
  const adxOk = Number.isFinite(curr.adx14) && curr.adx14 >= ADX_TREND_FLOOR;

  if (bullishCross && rsiOk && adxOk) {
    const atr = curr.atr14;
    const hasAtr = Number.isFinite(atr) && atr > 0;
    const tpAtrMult = tpAtrMultFor(params, rrMultiple);
    return {
      action: 'BUY',
      reason: `${params.fastKey.toUpperCase()} crossed above ${params.slowKey.toUpperCase()}, RSI ${rsiVal.toFixed(1)} confirms momentum, ADX ${curr.adx14.toFixed(1)} confirms a real trend.`,
      confidencePct,
      entryPrice: curr.close,
      stopPrice: hasAtr ? roundToTick(curr.close - atr * params.slAtrMult) : null,
      targetPrice: hasAtr ? roundToTick(curr.close + atr * tpAtrMult) : null,
      maxHoldUntil: new Date(curr.time * 1000 + params.maxHoldBars * params.barMs).toISOString()
    };
  }
  if (bullishCross && !rsiOk) {
    return { action: 'HOLD', reason: `EMA cross fired but RSI ${rsiVal?.toFixed?.(1) ?? 'n/a'} is outside the confirmation band - skipping to avoid a weak signal.`, confidencePct };
  }
  if (bullishCross && !adxOk) {
    return { action: 'HOLD', reason: `EMA cross fired but ADX ${Number.isFinite(curr.adx14) ? curr.adx14.toFixed(1) : 'n/a'} is below ${ADX_TREND_FLOOR} - market reads range-bound/choppy, skipping to avoid a whipsaw.`, confidencePct };
  }
  return { action: 'HOLD', reason: 'No fresh bullish EMA cross on the latest candle.', confidencePct };
}

// Open position: ratchet a trailing stop, then check stop, target, max hold,
// and a bearish EMA cross (trend exit) in that order - same priority the
// backtest used, just with the stop now trailing instead of fixed.
// Exits are never gated by confidence - once a stop or target is hit, it
// executes regardless, so a low confidence reading can never leave a losing
// position open past its own risk plan.
//
// Trailing stop mechanism (chandelier-style): position.highWaterMark tracks
// the highest candle high seen since entry; the stop is recomputed each call
// as highWaterMark - atr14*slAtrMult, using the exact same ATR multiple that
// sized the original entry stop, and only ever ratchets UP (Math.max against
// the previously stored stopPrice) - it can never move further away than the
// risk already accepted at entry. The caller (robotEngine.js) is responsible
// for persisting the returned highWaterMark/stopPrice back onto the stored
// position every tick, even on a HOLD, so next tick's trail starts from the
// ratcheted value rather than recomputing from the original entry stop.
// Take-profit stays a fixed target, unaffected - only the loss side trails.
//
// `nowMs` defaults to the real wall clock (correct for the live app, which
// calls this with no 4th argument) but scripts/benchmark.mjs passes its
// simulated tick time here explicitly. Without this, the max-hold check
// below would compare a HISTORICAL maxHoldUntil against the REAL current
// time during a backtest - which is always past it - closing every
// simulated position after a single 15-minute tick instead of its real
// maxHoldBars duration. That bug was live in this backtest for this whole
// session before being caught: 94 of 108 closed trades in one 3-month/
// 8-symbol run exited via "max hold" at an average holdMs of exactly one
// tick, never the intended 2h/16h/20d window - which also silently made
// every confidence-threshold/RR-template/entry-filter sweep meaningless,
// since stop-loss and take-profit barely had 15 minutes to ever be reached.
export function evaluateExit(candles, position, mode, { nowMs } = {}) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles.at(-1);
  const prev = candles.at(-2);
  const confidencePct = computeConfidencePct(candles, mode);
  if (!curr) return { action: 'HOLD', reason: 'No price data.', confidencePct };
  const price = curr.close;
  const effectiveNowMs = nowMs ?? Date.now();

  // Ratchet the trailing stop before evaluating anything else, so a stop hit
  // this same tick is checked against the freshly-trailed value, not last
  // tick's. highWaterMark falls back to entryPrice for positions opened
  // before this field existed.
  const priorHigh = Number.isFinite(position.highWaterMark) ? position.highWaterMark : position.entryPrice;
  const highWaterMark = Math.max(priorHigh, Number.isFinite(curr.high) ? curr.high : price);
  let stopPrice = Number.isFinite(position.stopPrice) ? position.stopPrice : null;
  if (Number.isFinite(curr.atr14) && curr.atr14 > 0 && Number.isFinite(highWaterMark)) {
    const trailingCandidate = roundToTick(highWaterMark - curr.atr14 * params.slAtrMult);
    stopPrice = Number.isFinite(stopPrice) ? Math.max(stopPrice, trailingCandidate) : trailingCandidate;
  }
  const trailed = Number.isFinite(position.stopPrice) && Number.isFinite(stopPrice) && stopPrice > position.stopPrice;

  if (Number.isFinite(stopPrice) && price <= stopPrice) {
    return {
      action: 'SELL',
      reason: `${trailed ? 'Trailing stop' : 'Stop-loss'} hit at ${price} (stop was ${stopPrice}).`,
      confidencePct, highWaterMark, stopPrice
    };
  }
  if (Number.isFinite(position.targetPrice) && price >= position.targetPrice) {
    return { action: 'SELL', reason: `Take-profit hit at ${price} (target was ${position.targetPrice}).`, confidencePct, highWaterMark, stopPrice };
  }
  if (position.maxHoldUntil && effectiveNowMs >= new Date(position.maxHoldUntil).getTime()) {
    return { action: 'SELL', reason: `Max hold window (${params.maxHoldBars} bars) elapsed - exiting on time, not signal.`, confidencePct, highWaterMark, stopPrice };
  }
  if (prev) {
    const fastNow = curr[params.fastKey];
    const slowNow = curr[params.slowKey];
    const fastPrev = prev[params.fastKey];
    const slowPrev = prev[params.slowKey];
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

// For the manual Buy button in the UI: same ATR-based stop/target sizing as
// an automatic entry (respecting the user's chosen risk template), but skips
// the EMA-cross gate since the user is consciously overriding the signal.
export function planManualEntry(candles, mode, { rrMultiple } = {}) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles.at(-1);
  if (!curr) return null;
  const atr = curr.atr14;
  const hasAtr = Number.isFinite(atr) && atr > 0;
  const tpAtrMult = tpAtrMultFor(params, rrMultiple);
  return {
    action: 'BUY',
    reason: 'Manual buy - user override.',
    confidencePct: computeConfidencePct(candles, mode),
    entryPrice: curr.close,
    stopPrice: hasAtr ? roundToTick(curr.close - atr * params.slAtrMult) : null,
    targetPrice: hasAtr ? roundToTick(curr.close + atr * tpAtrMult) : null,
    maxHoldUntil: new Date(curr.time * 1000 + params.maxHoldBars * params.barMs).toISOString()
  };
}

// Rounds a stop/target price to a precision that scales with the price's own
// magnitude, not a fixed 2 decimal places. A fixed 2-decimal round is fine
// for a ~$80,000 BTC price but silently collapses the entire ATR-based stop/
// target distance for a sub-$1 coin (e.g. DOGE at $0.07, where the real
// computed target and the entry price can round to the exact same 2-decimal
// value, or even flip the target below entry) - found by tracing a DOGEUSDT
// backtest trade that "hit take-profit" at a loss because its rounded
// target (0.07) had collapsed below its own entry price (0.07005).
function roundToTick(value) {
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 2 : magnitude >= 1 ? 4 : magnitude >= 0.01 ? 6 : 8;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Human-readable read-out of exactly which numbers the active mode is
// trading on right now - the same STRATEGY_PARAMS values that drive
// evaluateEntry/evaluateExit above, translated into UI-friendly labels so the
// "Indicators" card can show what the robot is actually watching, not just
// its name.
function describeHold(bars, barMs) {
  const hours = (bars * barMs) / 3_600_000;
  if (hours < 1) return `${bars} bars`;
  if (hours < 48) return `${bars} bars (~${Math.round(hours)}h max hold)`;
  return `${bars} bars (~${Math.round(hours / 24)}d max hold)`;
}

export function describeStrategyParams(mode, rrMultiple) {
  const params = STRATEGY_PARAMS[mode];
  if (!params) return null;
  const rsiRangeLabel = [
    params.rsiFloor !== undefined ? `>= ${params.rsiFloor}` : null,
    params.rsiCeiling !== undefined ? `<= ${params.rsiCeiling}` : null
  ].filter(Boolean).join(' and ');
  return {
    mode,
    label: params.label,
    emaCrossLabel: `${params.fastKey.toUpperCase()} / ${params.slowKey.toUpperCase()}`,
    rsiLabel: params.rsiKey.toUpperCase(),
    rsiRangeLabel: rsiRangeLabel || 'no band filter',
    slAtrMult: params.slAtrMult,
    tpAtrMult: Math.round(tpAtrMultFor(params, rrMultiple) * 100) / 100,
    maxHoldBars: params.maxHoldBars,
    holdLabel: describeHold(params.maxHoldBars, params.barMs)
  };
}
// "How close is this to actually triggering?" - a plain-language, numeric
// readout of the gap between right now and a real BUY/SELL, separate from
// confidencePct. evaluateEntry only fires BUY on the exact bar of a fresh
// EMA cross with RSI+ADX confirming - every other bar it's HOLD, with no
// distinction between "nowhere close" and "one tick away." Confidence
// doesn't answer that either (it can be high or low on either side of a
// cross). This function is purely descriptive - it reads the same fields
// evaluateEntry/evaluateExit already use, but never changes what fires; it
// only explains what those functions are watching, including the ADX
// trend-floor gate added above (a real, common reason a fresh EMA+RSI
// signal still gets skipped).
function round2(value) {
  return Math.round(value * 100) / 100;
}

function describeDuration(ms) {
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  return `${Math.round(hours / 24)}d`;
}

export function describeNearCondition(candles, mode, position) {
  const params = STRATEGY_PARAMS[mode];
  const curr = candles?.at(-1);
  if (!params || !curr) return null;

  if (position) {
    const price = curr.close;
    const distanceToStopPct = Number.isFinite(position.stopPrice) && price > 0
      ? round2(((price - position.stopPrice) / price) * 100) : null;
    const distanceToTargetPct = Number.isFinite(position.targetPrice) && price > 0
      ? round2(((position.targetPrice - price) / price) * 100) : null;

    let nearer = null;
    if (distanceToStopPct != null && distanceToTargetPct != null) {
      nearer = Math.abs(distanceToStopPct) <= Math.abs(distanceToTargetPct) ? 'stop' : 'target';
    } else if (distanceToStopPct != null) nearer = 'stop';
    else if (distanceToTargetPct != null) nearer = 'target';

    const parts = [];
    if (distanceToStopPct != null) parts.push(`${Math.abs(distanceToStopPct)}% ${distanceToStopPct >= 0 ? 'above' : 'past'} stop-loss`);
    if (distanceToTargetPct != null) parts.push(`${Math.abs(distanceToTargetPct)}% ${distanceToTargetPct >= 0 ? 'below' : 'past'} take-profit`);
    let holdNote = '';
    if (position.maxHoldUntil) {
      const msLeft = new Date(position.maxHoldUntil).getTime() - Date.now();
      holdNote = msLeft > 0 ? `, max-hold exit in ~${describeDuration(msLeft)}` : ', max-hold window has elapsed - due to exit on time';
    }

    return {
      kind: 'exit',
      nearer,
      distanceToStopPct,
      distanceToTargetPct,
      note: (parts.length ? parts.join(', ') : 'No stop/target recorded for this position.') + holdNote
    };
  }

  const fast = curr[params.fastKey];
  const slow = curr[params.slowKey];
  const emaReady = finite(fast, slow) && slow !== 0;
  const emaGapPct = emaReady ? round2(((fast - slow) / Math.abs(slow)) * 100) : null;
  const alreadyBullish = emaReady && fast > slow;

  const rsiVal = curr[params.rsiKey];
  const floor = params.rsiFloor;
  const ceiling = params.rsiCeiling;
  let rsiState = 'n/a';
  let rsiOk = true;
  if (Number.isFinite(rsiVal)) {
    if (floor !== undefined && rsiVal < floor) { rsiState = `${round2(floor - rsiVal)} below the ${floor} floor`; rsiOk = false; }
    else if (ceiling !== undefined && rsiVal > ceiling) { rsiState = `${round2(rsiVal - ceiling)} above the ${ceiling} ceiling`; rsiOk = false; }
    else rsiState = 'inside the confirmation band';
  }

  // Same ADX_TREND_FLOOR evaluateEntry() gates a fresh cross on above - shared constant, not duplicated.
  const adxVal = curr.adx14;
  const adxOk = Number.isFinite(adxVal) && adxVal >= ADX_TREND_FLOOR;
  const adxNote = Number.isFinite(adxVal)
    ? `ADX ${adxVal.toFixed(1)} is ${adxOk ? `at/above the ${ADX_TREND_FLOOR} trend floor` : `${round2(ADX_TREND_FLOOR - adxVal)} below the ${ADX_TREND_FLOOR} trend floor - market reads range-bound, would block a fresh signal right now even if EMA+RSI lined up`}.`
    : 'ADX not available yet.';

  const emaNote = !emaReady
    ? 'EMA lines still warming up.'
    : alreadyBullish
      ? `EMA already bullish (+${Math.abs(emaGapPct)}% gap) - already past its cross, waiting for the NEXT fresh one, not this gap closing further.`
      : `EMA fast is ${Math.abs(emaGapPct)}% below slow - needs to close that gap to a bullish cross before anything can fire.`;
  const rsiNote = `RSI${params.rsiKey.replace('rsi', '')} ${Number.isFinite(rsiVal) ? rsiVal : 'n/a'} is ${rsiState}${rsiOk ? '' : ' - would block a fresh signal right now even if the EMA cross fired'}.`;

  return {
    kind: 'entry',
    emaGapPct,
    alreadyBullish,
    rsiValue: Number.isFinite(rsiVal) ? rsiVal : null,
    rsiOk,
    adxValue: Number.isFinite(adxVal) ? adxVal : null,
    adxOk,
    note: `${emaNote} ${rsiNote} ${adxNote}`
  };
}
