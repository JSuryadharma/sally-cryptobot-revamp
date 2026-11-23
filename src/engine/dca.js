// Averaging down (DCA) instead of (or before) taking the stop-loss. The default
// is the plain scale-in at the stop (cfg.dca = SCALE_IN_AT_STOP); the spike
// modes are research only. See
// scripts/dcaBacktest.mjs and docs/research/dca-spike-2026-11-23.md.
//
// A "spike" is measured on the last `windowBars` closed exit candles (5m):
//   - their range (including the gap from the close before the window) is at
//     least `rangeMult` x the ATR14 of the reference timeframe (`refTf`, 1h),
//   - their volume is at least `volMult` x that timeframe's 20-bar average
//     volume (scaled to the window length), and
//   - price fell over the window (a red, selling candle).
// Both reference values come from the last refTf candle closed before the
// window starts, so the spike itself can't inflate them.
//
// Modes:
//   'pre'     - while the trade is at least `armR` under water, a spike adds
//               to the position at that 5m close.
//   'replace' - only on the 5m candle that reaches the stop: with a spike,
//               the robot buys more at that close instead of selling;
//               without one, the stop fills as usual.
// After an add the stop moves to the hard stop: the price where the whole
// position (all lots, after costs) loses `capR` x the trade's original risk,
// or `stopAtr` x the trigger ATR under the add price when that is higher.
import { profilesFor, TF_MS } from './config.js';
import { lastClosedIndex } from './bars.js';
import { addToPosition } from './ledger.js';

export const DCA_DEFAULTS = {
  mode: 'pre',
  profiles: ['breakout', 'breakout55'],
  refTf: '1h',
  windowBars: 12,
  rangeMult: 3,
  volMult: 3,
  red: true,
  armR: 0.5,
  addFrac: 1,
  maxAdds: 1,
  minGapBars: 12,
  capR: 2,
  stopAtr: null,
  target: 'keep',
  targetR: 1
};

// The default (engine/config.js SCALE_IN_AT_STOP): the one variant that beat
// the plain stop in both test periods.
export { SCALE_IN_AT_STOP } from './config.js';

export function dcaCfgOf(cfg) {
  return cfg?.dca ? { ...DCA_DEFAULTS, ...cfg.dca } : null;
}

// The spike test on exit candles bars[i-windowBars+1..i].
export function spikeAt(series, symbol, exitTf, i, d) {
  const bars = series[symbol]?.[exitTf];
  const ref = series[symbol]?.[d.refTf];
  if (!bars || !ref || i < d.windowBars) return null;
  const first = i - d.windowBars + 1;
  const prevClose = bars[first - 1].close;
  let hi = prevClose, lo = prevClose, vol = 0;
  for (let k = first; k <= i; k += 1) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
    vol += bars[k].volume || 0;
  }
  const ri = lastClosedIndex(ref, d.refTf, bars[first].time * 1000);
  if (ri < 0) return null;
  const atr = ref[ri].atr14, avgVol = ref[ri].volumeSma20;
  if (!(atr > 0) || !(avgVol > 0)) return null;
  const scale = (d.windowBars * TF_MS[exitTf]) / TF_MS[d.refTf];
  const rangeX = (hi - lo) / atr;
  const volX = vol / (avgVol * scale);
  const red = bars[i].close < prevClose;
  const ok = rangeX >= d.rangeMult && volX >= d.volMult && (!d.red || red);
  return { ok, rangeX, volX, red };
}

function eligible(position, d, cfg, i) {
  if (!d.profiles.includes(position.profile)) return false;
  if ((position.dcaAdds || 0) >= d.maxAdds) return false;
  if (position.dcaLastIndex != null && i - position.dcaLastIndex < d.minGapBars) return false;
  return Boolean(profilesFor(cfg)[position.profile]);
}

// The stop where all lots together lose capR x the original risk, after costs.
function capStopFor(position, d, cfg, usdIdrRate) {
  const k = usdIdrRate * (1 - cfg.roundTripCostPct / 200) * (1 - cfg.slippagePct / 100);
  return (position.investedIdr - d.capR * position.riskIdr) / (position.quantity * k);
}

// Buys addFrac x the first lot at `price` and moves the stop (and target).
// Returns the BUY transaction, or null when the add doesn't fit.
function doAdd(ctx, symbol, price, bar, triggerAtr, why) {
  const { portfolio, cfg, usdIdrRate } = ctx;
  const d = dcaCfgOf(cfg);
  const position = portfolio.positions[symbol];
  const fill = price * (1 + cfg.slippagePct / 100);
  const qty = position.initialQuantity * d.addFrac;
  const before = { quantity: position.quantity, investedIdr: position.investedIdr };
  const { transaction } = addToPosition(portfolio, {
    symbol, quantity: qty, price: fill, reason: why, timeMs: ctx.timeFor(bar), barTime: bar.time,
    usdIdrRate, roundTripCostPct: cfg.roundTripCostPct, keepAllTransactions: ctx.keepAll
  });
  if (!transaction) return null;
  let stop = capStopFor(position, d, cfg, usdIdrRate);
  if (d.stopAtr && triggerAtr > 0) stop = Math.max(stop, fill - d.stopAtr * triggerAtr);
  // The hard stop must leave room under the add, or the add is pointless.
  if (!(stop < fill * 0.99)) {
    // Undo: sell the lot just bought at the same price (costs charged).
    position.quantity = before.quantity;
    position.investedIdr = before.investedIdr;
    position.investedUsdt = Math.round((before.investedIdr / usdIdrRate) * 100) / 100;
    portfolio.balanceIdr = Math.round((portfolio.balanceIdr + transaction.spendIdr) * 100) / 100;
    portfolio.transactions.shift();
    return null;
  }
  position.stopPrice = Number(stop.toPrecision(8));
  position.dcaAdds = (position.dcaAdds || 0) + 1;
  position.dcaLastSpendIdr = transaction.spendIdr;
  transaction.stopPrice = position.stopPrice;
  if (d.target === 'avg') {
    const avg = position.investedIdr / (position.quantity * usdIdrRate);
    position.targetPrice = avg + d.targetR * (position.entryPrice - position.initialStop);
  }
  return transaction;
}

// Called on every closed exit candle of an open position.
// phase 'stop': the candle reached the stop; returns true when the robot
// added instead of selling. phase 'after': the position survived the candle.
export function dcaOnExitBar(ctx, event, position, bar, triggerAtr, phase) {
  const d = dcaCfgOf(ctx.cfg);
  if (!d || !eligible(position, d, ctx.cfg, event.i)) return false;
  if (phase === 'stop' && d.mode !== 'replace') return false;
  if (phase === 'after' && d.mode !== 'pre') return false;
  const risk = position.entryPrice - position.initialStop;
  if (!(risk > 0)) return false;
  if (phase === 'after' && (position.entryPrice - bar.close) / risk < d.armR) return false;
  const needsSpike = d.rangeMult > 0 || d.volMult > 0 || d.red;
  const spike = needsSpike ? spikeAt(ctx.series, event.symbol, event.tf, event.i, d) : null;
  if (needsSpike && !spike?.ok) return false;
  const why = needsSpike
    ? `DCA: ${d.windowBars * 5}m spike ${spike.rangeX.toFixed(1)}x ATR, volume ${spike.volX.toFixed(1)}x avg.`
    : `Scale-in: the stop was reached, bought ${d.addFrac}x more instead of selling.`;
  const tx = doAdd(ctx, event.symbol, bar.close, bar, triggerAtr, why);
  if (!tx) return false;
  position.dcaLastIndex = event.i;
  tx.reason = `${why} New stop ${position.stopPrice} (all lots lose at most ${d.capR}R).`;
  ctx.out.transactions.push(tx);
  ctx.out.dcaEvents?.push({ symbol: event.symbol, at: tx.createdAt, price: tx.price, rangeX: spike?.rangeX, volX: spike?.volX, stop: position.stopPrice, mode: d.mode });
  return true;
}
