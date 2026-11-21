// Pullback strategy (profiles `swing`, `trend`, `scalping`; off by default
// since the 2026-09 research): trend on the filter timeframe, a dip to EMA20,
// then a reclaim of the previous candle's high. With cfg.earlyEntry the
// reclaim is also checked on every closed earlyTf candle (the forming trigger
// candle), so it can buy before the 4h/daily close.
import { TF_MS, BTC_SYMBOL } from '../config.js';
import { evaluateSetup } from '../setups.js';
import { enrichCandles } from '../../indicators.js';
import { lastClosedIndex, formingCandle } from '../bars.js';

// Closed trigger candles fed to the indicators with the forming one. 250 bars
// is plenty for EMA50/ATR14/ADX14 to converge.
const EARLY_WINDOW = 250;

function usesIntrabar(profile, cfg) {
  return Boolean(cfg.earlyEntry) && profile.earlyEntry !== false && Boolean(TF_MS[cfg.earlyTf]) && TF_MS[cfg.earlyTf] < TF_MS[profile.triggerTf];
}

// Same pullback test evaluatePullback() runs for a trigger candle at ci + 1,
// from the closed candles alone.
function pullbackSeen(trig, ci, cfg) {
  const p = cfg.setup;
  let touched = false;
  let minRsi = Infinity;
  for (let k = ci + 1 - p.pullbackLookback; k <= ci; k += 1) {
    const b = trig[k];
    if (!b || !Number.isFinite(b.low) || !Number.isFinite(b.ema20) || !Number.isFinite(b.atr14) || !Number.isFinite(b.rsi14) || b.atr14 <= 0) continue;
    if ((b.low - b.ema20) / b.atr14 <= p.pullbackTouchAtr) touched = true;
    minRsi = Math.min(minRsi, b.rsi14);
  }
  return touched && minRsi >= p.rsiDipMin && minRsi <= p.rsiDipMax;
}

function btcCtx(series, profile, cfg, closeMs) {
  if (!cfg.btcGate || !series[BTC_SYMBOL]?.[profile.filterTf]) return null;
  const btcFilt = series[BTC_SYMBOL][profile.filterTf];
  return { filt: btcFilt, j: lastClosedIndex(btcFilt, profile.filterTf, closeMs) };
}

// Setup check on the forming trigger candle at an early-candle close.
function evaluateIntrabar(ctx, event, profile) {
  const { series, cfg } = ctx;
  const trigAll = series[event.symbol][profile.triggerTf];
  const sub = series[event.symbol][cfg.earlyTf];
  if (!trigAll || event.closeMs % TF_MS[profile.triggerTf] === 0) return null; // the candle's own close is checked normally
  const ci = lastClosedIndex(trigAll, profile.triggerTf, event.closeMs);
  if (ci < 1) return null;
  const forming = formingCandle(sub, event.i, profile.triggerTf);
  if (!(forming.close > trigAll[ci].high)) return null; // cheap pre-checks first: no reclaim yet,
  if (!pullbackSeen(trigAll, ci, cfg)) return null; // or no pullback to buy
  const trig = enrichCandles(trigAll.slice(Math.max(0, ci - EARLY_WINDOW + 1), ci + 1).concat(forming));
  const filt = series[event.symbol][profile.filterTf];
  const j = lastClosedIndex(filt, profile.filterTf, event.closeMs);
  const evaluation = evaluateSetup({ trig, i: trig.length - 1, filt, j: j < 0 ? null : j, profile, cfg, btc: btcCtx(series, profile, cfg, event.closeMs) });
  const signal = evaluation.signal && { ...evaluation.signal, reason: `${evaluation.signal.reason} Bought early on a ${cfg.earlyTf} check, before the ${profile.triggerTf} close.` };
  return { ...evaluation, signal, barTime: forming.time };
}

function evaluateClose(ctx, event, profile) {
  const { series, cfg } = ctx;
  const trig = series[event.symbol][profile.triggerTf];
  const filt = series[event.symbol][profile.filterTf];
  if (!filt) return null;
  const j = lastClosedIndex(filt, profile.filterTf, event.closeMs);
  return evaluateSetup({ trig, i: event.i, filt, j: j < 0 ? null : j, profile, cfg, btc: btcCtx(series, profile, cfg, event.closeMs) });
}

export const pullbackStrategy = {
  key: 'pullback',
  usesIntrabar,
  evaluateIntrabar,
  evaluateClose
};
