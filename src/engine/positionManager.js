import { profileTimeStopBars, profileTrailAtr } from './config.js';

// Manages one open position across one closed trigger-timeframe bar. Pure:
// returns the fills and the updated management fields without mutating input.
//
// Order inside a bar is unknowable from OHLC, so it is resolved pessimistically:
// the stop is checked before the 1R partial, and stops raised during this bar
// (breakeven, trail) only apply from the next bar. Stops model resting exchange
// orders, filling at the stop price (or the open, if the bar gapped below it)
// no matter how late the engine processes the bar.
export function onBar(position, bar, profile, cfg) {
  const fills = [];
  const slip = cfg.slippagePct / 100;
  const riskPerUnit = position.entryPrice - position.initialStop;
  const stop = position.stopPrice;
  const stopLabel = stop >= position.entryPrice ? (position.partialTaken && stop > position.entryPrice * (1 + cfg.roundTripCostPct / 100) ? 'Trailing stop' : 'Breakeven stop') : 'Stop-loss';

  if (bar.open <= stop) {
    fills.push({ fraction: 1, price: bar.open * (1 - slip), exitKind: 'stop', reason: `${stopLabel} gapped: opened at ${bar.open}, below stop ${stop}.` });
    return { fills, updates: null };
  }
  if (bar.low <= stop) {
    fills.push({ fraction: 1, price: stop * (1 - slip), exitKind: 'stop', reason: `${stopLabel} hit at ${stop}.` });
    return { fills, updates: null };
  }

  const updates = {
    stopPrice: stop,
    highWaterMark: Math.max(position.highWaterMark ?? position.entryPrice, bar.high),
    barsHeld: (position.barsHeld || 0) + 1,
    partialTaken: position.partialTaken,
    mfeR: riskPerUnit > 0 ? Math.max(position.mfeR || 0, (bar.high - position.entryPrice) / riskPerUnit) : position.mfeR || 0
  };

  // partialTaken doubles as "1R reached": it arms breakeven and the trail even
  // when partialFraction is 0 and nothing is sold there.
  const partialPrice = position.entryPrice + cfg.partialAtR * riskPerUnit;
  let nextStop = stop;
  if (!position.partialTaken && riskPerUnit > 0 && bar.high >= partialPrice) {
    if (cfg.partialFraction > 0) {
      fills.push({ fraction: cfg.partialFraction, price: partialPrice, exitKind: 'partial', reason: `Took ${Math.round(cfg.partialFraction * 100)}% at +${cfg.partialAtR}R (${partialPrice.toPrecision(8)}); stop moved to breakeven.` });
    }
    updates.partialTaken = true;
    nextStop = Math.max(nextStop, position.entryPrice * (1 + cfg.roundTripCostPct / 100));
  }

  const targetPrice = cfg.targetR ? position.entryPrice + cfg.targetR * riskPerUnit : null;
  if (targetPrice && riskPerUnit > 0 && bar.high >= targetPrice) {
    fills.push({ fraction: 1, price: targetPrice, exitKind: 'target', reason: `Target +${cfg.targetR}R hit at ${targetPrice.toPrecision(8)}.` });
    return { fills, updates };
  }

  if (updates.partialTaken && Number.isFinite(bar.atr14) && bar.atr14 > 0) {
    nextStop = Math.max(nextStop, updates.highWaterMark - profileTrailAtr(profile, cfg) * bar.atr14);
  }
  updates.stopPrice = Number(nextStop.toPrecision(8));

  if (cfg.trendExit !== false && Number.isFinite(bar.ema50) && bar.close < bar.ema50) {
    fills.push({ fraction: 1, price: bar.close * (1 - slip), exitKind: 'trend', reason: `Trend break: ${profile.triggerTf} close ${bar.close} below EMA50 ${bar.ema50.toPrecision(8)}.` });
  } else if (updates.barsHeld >= profileTimeStopBars(profile, cfg) && updates.mfeR < cfg.timeStopMinR) {
    fills.push({ fraction: 1, price: bar.close * (1 - slip), exitKind: 'time', reason: `Time stop: ${updates.barsHeld} bars without reaching +${cfg.timeStopMinR}R.` });
  }
  return { fills, updates };
}
