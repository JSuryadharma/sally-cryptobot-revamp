import { profileTimeStopBars, profileTrailAtr, profileTargetR, profileTimeStopMinR, profileBreakeven } from './config.js';

// Manages one open position across one closed trigger-timeframe bar. Pure:
// returns the fills and the updated management fields without mutating input.
//
// Order inside a bar is unknowable from OHLC, so it is resolved pessimistically:
// the stop is checked before the 1R partial, and stops raised during this bar
// (breakeven, trail) only apply from the next bar. Stops model resting exchange
// orders, filling at the stop price (or the open, if the bar gapped below it)
// no matter how late the engine processes the bar.
export function onBar(position, bar, profile, cfg, { priceExits = true } = {}) {
  const fills = [];
  const slip = cfg.slippagePct / 100;
  const updates = priceExits
    ? priceStep(position, bar, profile, cfg, fills)
    : { stopPrice: position.stopPrice, highWaterMark: position.highWaterMark ?? position.entryPrice, partialTaken: position.partialTaken, mfeR: position.mfeR || 0 };
  if (!updates || updates.done) return { fills, updates: updates && strip(updates) };
  updates.barsHeld = (position.barsHeld || 0) + 1;

  let nextStop = updates.stopPrice;
  const trailAtr = profileTrailAtr(profile, cfg);
  if (updates.partialTaken && trailAtr && Number.isFinite(bar.atr14) && bar.atr14 > 0) {
    nextStop = Math.max(nextStop, updates.highWaterMark - trailAtr * bar.atr14);
  }
  updates.stopPrice = Number(nextStop.toPrecision(8));

  if (cfg.trendExit !== false && Number.isFinite(bar.ema50) && bar.close < bar.ema50) {
    fills.push({ fraction: 1, price: bar.close * (1 - slip), exitKind: 'trend', reason: `Trend break: ${profile.triggerTf} close ${bar.close} below EMA50 ${bar.ema50.toPrecision(8)}.` });
  } else if (updates.barsHeld >= profileTimeStopBars(profile, cfg) && updates.mfeR < profileTimeStopMinR(profile, cfg)) {
    const minR = profileTimeStopMinR(profile, cfg);
    fills.push({ fraction: 1, price: bar.close * (1 - slip), exitKind: 'time', reason: Number.isFinite(minR) ? `Time stop: ${updates.barsHeld} bars without reaching +${minR}R.` : `Time stop: held ${updates.barsHeld} bars without reaching the target.` });
  }
  return { fills, updates };
}

// Manages one open position across one closed exit-timeframe candle (5m by
// default) between trigger-candle closes, so the stop, the target and the
// breakeven/trail moves react within minutes instead of waiting for the 4h
// (or daily) close. `atr` is the last closed trigger candle's ATR14, for the
// trail. Bars held, the trend exit and the time stop stay on the trigger close.
export function onExitBar(position, bar, profile, cfg, atr) {
  const fills = [];
  const updates = priceStep(position, bar, profile, cfg, fills);
  if (!updates || updates.done) return { fills, updates: updates && strip(updates) };
  const trailAtr = profileTrailAtr(profile, cfg);
  if (updates.partialTaken && trailAtr && Number.isFinite(atr) && atr > 0) {
    updates.stopPrice = Math.max(updates.stopPrice, updates.highWaterMark - trailAtr * atr);
  }
  updates.stopPrice = Number(updates.stopPrice.toPrecision(8));
  return { fills, updates };
}

function strip({ done, ...rest }) {
  return rest;
}

// Stop, 1R breakeven/partial and target checks against one candle's range.
// Returns null when the stop filled, the management fields otherwise, with
// done set when the target filled. A stop raised here applies from the next candle.
function priceStep(position, bar, profile, cfg, fills) {
  const slip = cfg.slippagePct / 100;
  const riskPerUnit = position.entryPrice - position.initialStop;
  const stop = position.stopPrice;
  const stopLabel = stop >= position.entryPrice ? (position.partialTaken && stop > position.entryPrice * (1 + cfg.roundTripCostPct / 100) ? 'Trailing stop' : 'Breakeven stop') : 'Stop-loss';

  if (bar.open <= stop) {
    fills.push({ fraction: 1, price: bar.open * (1 - slip), exitKind: 'stop', reason: `${stopLabel} gapped: opened at ${bar.open}, below stop ${stop}.` });
    return null;
  }
  if (bar.low <= stop) {
    fills.push({ fraction: 1, price: stop * (1 - slip), exitKind: 'stop', reason: `${stopLabel} hit at ${stop}.` });
    return null;
  }

  const updates = {
    stopPrice: stop,
    highWaterMark: Math.max(position.highWaterMark ?? position.entryPrice, bar.high),
    partialTaken: position.partialTaken,
    mfeR: riskPerUnit > 0 ? Math.max(position.mfeR || 0, (bar.high - position.entryPrice) / riskPerUnit) : position.mfeR || 0
  };

  // partialTaken doubles as "1R reached": it arms breakeven and the trail even
  // when partialFraction is 0 and nothing is sold there.
  const partialPrice = position.entryPrice + cfg.partialAtR * riskPerUnit;
  if (profileBreakeven(profile, cfg) && !position.partialTaken && riskPerUnit > 0 && bar.high >= partialPrice) {
    if (cfg.partialFraction > 0) {
      fills.push({ fraction: cfg.partialFraction, price: partialPrice, exitKind: 'partial', reason: `Took ${Math.round(cfg.partialFraction * 100)}% at +${cfg.partialAtR}R (${partialPrice.toPrecision(8)}); stop moved to breakeven.` });
    }
    updates.partialTaken = true;
    updates.stopPrice = Math.max(updates.stopPrice, position.entryPrice * (1 + cfg.roundTripCostPct / 100));
  }

  const targetR = profileTargetR(profile, cfg);
  const targetPrice = targetR ? position.entryPrice + targetR * riskPerUnit : null;
  if (targetPrice && riskPerUnit > 0 && bar.high >= targetPrice) {
    // A bar that opened above the target fills at its open.
    const price = Math.max(targetPrice, bar.open);
    fills.push({ fraction: 1, price, exitKind: 'target', reason: `Target +${targetR}R hit at ${price.toPrecision(8)}.` });
    updates.done = true;
  }
  return updates;
}
