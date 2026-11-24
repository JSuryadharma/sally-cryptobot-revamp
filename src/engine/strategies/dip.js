// Dip-buy strategy (profile `idxDip`, IDX stocks): buy a short, sharp dip in a
// stock that is still in an uptrend, sell on the first bounce.
//   Buy at the daily close when the stock closes above its 200-day average and
//   its 2-day RSI is under 10.
//   Sell at the first daily close above the 5-day average (positionManager,
//   profile.smaExitBars), or after 10 days (time stop). A wide disaster stop
//   (profile.dipStopPct under the entry) is the only price stop.
// No market (IHSG) filter: Joe chose it so the robot still trades while IHSG
// blocks the breakouts (2026-11-24).
// Research (docs/research/idx-dip-signal-2026-11-24.md, 14 IDX stocks,
// 2010-2026, close-only): train 2010-20 67.4% wins vs 58.2% needed (z 4.67,
// 631 trades), test 2021-26 67.8% vs 58.0% (z 4.62, 543 trades), +0.5%/trade.
import { quoteVolume24h } from '../setups.js';
import { roundPx } from '../bars.js';

// Wilder RSI over `n` closes, warmed up on the `warm` closes before index i.
export function rsiAt(bars, i, n = 2, warm = 50) {
  const start = Math.max(1, i - warm);
  if (i - start < n) return null;
  let gain = 0, loss = 0;
  for (let k = start; k <= i; k += 1) {
    const ch = bars[k].close - bars[k - 1].close;
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (k - start < n) { gain += up / n; loss += dn / n; } else { gain = (gain * (n - 1) + up) / n; loss = (loss * (n - 1) + dn) / n; }
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function smaAt(bars, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k += 1) s += bars[k].close;
  return s / n;
}

// The rule on bar i, for the engine and the Saham tab.
export function dipCheck(bars, i, profile) {
  const c = bars[i];
  const sma = smaAt(bars, i, profile.trendSmaBars);
  const rsi = rsiAt(bars, i, profile.rsiBars);
  if (sma == null || rsi == null) return null;
  const uptrend = c.close > sma;
  const dip = rsi < profile.rsiMax;
  return { ok: uptrend && dip, uptrend, dip, rsi: Math.round(rsi * 10) / 10, sma: roundPx(sma), close: c.close };
}

function evaluateClose(ctx, event, profile) {
  const { series, cfg } = ctx;
  const bars = series[event.symbol][profile.triggerTf];
  if (!bars || event.i < profile.trendSmaBars) return null;
  const chk = dipCheck(bars, event.i, profile);
  if (!chk) return null;
  const liquidIdr = quoteVolume24h(bars, event.i, 1);
  const liquid = liquidIdr >= cfg.minTradeQuoteVolumeUsdt;
  const checklist = [
    { key: 'uptrend', label: `Close above the ${profile.trendSmaBars}-day average`, ok: chk.uptrend, detail: `${chk.close} vs ${chk.sma}` },
    { key: 'dip', label: `${profile.rsiBars}-day RSI under ${profile.rsiMax}`, ok: chk.dip, detail: `RSI ${chk.rsi}` },
    { key: 'tradeable', label: 'Liquid enough', ok: liquid, detail: `daily value ${Math.round(liquidIdr / 1e9)}B` }
  ];
  if (!chk.ok || !liquid) return { signal: null, checklist };
  const entry = chk.close;
  return {
    checklist,
    signal: {
      setup: 'dip', entryPrice: entry, stopPrice: roundPx(entry * (1 - profile.dipStopPct / 100)),
      // Deeper dips first when several stocks signal on the same close.
      score: Math.round(100 - chk.rsi * 5),
      reason: `Dip buy: close ${entry} above its ${profile.trendSmaBars}-day average ${chk.sma}, ${profile.rsiBars}-day RSI ${chk.rsi} under ${profile.rsiMax}. Sells at the first close above the ${profile.smaExitBars}-day average or after ${profile.timeStopBars} days.`
    }
  };
}

export const dipStrategy = {
  key: 'dip',
  followsAutopilot: false,
  usesIntrabar: () => false,
  evaluateIntrabar: () => null,
  evaluateClose
};
