// Gap rebound strategy (profile `gap`; paperGap.js has the rule and
// scripts/gapResearch.mjs the research). Checked at every closed 1h candle:
// the oldest daily gap from the last 10 days that price has not filled and
// that has not been traded yet, with price still below it and a 1h rebound now.
// Runs as a sleeve next to the breakouts, so an autopilot pause does not stop it.
import { TF_MS } from '../config.js';
import { gapAt, reboundAt, reboundPlan, GAP_RULE } from '../paperGap.js';
import { lastClosedIndex, firstAfter, symbolState, roundPx } from '../bars.js';

function evaluateClose(ctx, event, profile) {
  const { series, state } = ctx;
  if (!series[event.symbol][profile.filterTf]) return null;
  const hourly = series[event.symbol][profile.triggerTf];
  const daily = series[event.symbol][profile.filterTf];
  if (!hourly || !daily) return null;
  const sState = symbolState(state, event.symbol);
  const used = sState.gapsTraded || {};
  const ci = lastClosedIndex(daily, profile.filterTf, event.closeMs);
  if (ci < 0) return null;
  // Gaps older than the 10-day window can't trade again; keep the stored state small.
  for (const t of Object.keys(used)) if (Number(t) < daily[ci].time - 30 * 86_400) delete used[t];
  const liveBars = Math.round(GAP_RULE.liveDays * TF_MS['1d'] / TF_MS[profile.triggerTf]);
  const base = { signal: null, checklist: [] };
  if (!reboundAt(hourly, event.i)) return base;
  for (let k = Math.max(24, ci - GAP_RULE.liveDays); k <= ci; k += 1) {
    if (used[daily[k].time]) continue;
    const gap = gapAt(daily, k);
    if (!gap) continue;
    const i0 = firstAfter(hourly, daily[k].time + TF_MS['1d'] / 1000 - 1);
    if (i0 < 0 || event.i < i0 || event.i >= i0 + liveBars) continue;
    let filled = false;
    for (let m = i0; m <= event.i; m += 1) if (hourly[m].high >= gap.top) { filled = true; break; }
    if (filled || !(hourly[event.i].close < gap.bottom)) continue;
    const plan = reboundPlan(hourly, event.i);
    if (!plan || !(plan.target > plan.entry)) continue;
    return {
      ...base,
      gapTime: daily[k].time,
      signal: {
        setup: 'gap', entryPrice: plan.entry, stopPrice: roundPx(plan.exitStop), targetPrice: roundPx(plan.target),
        score: Math.min(100, Math.round(gap.volX * 10)),
        reason: `1h rebound under the ${daily[k].date} daily gap ${roundPx(gap.bottom)}-${roundPx(gap.top)} (gap-day volume ${Math.round(gap.volX * 10) / 10}x): RSI back from under 30, close above EMA20. Target ${roundPx(plan.target)}.`
      }
    };
  }
  return base;
}

export const gapStrategy = {
  key: 'gap',
  followsAutopilot: false,
  usesIntrabar: () => false,
  evaluateIntrabar: () => null,
  evaluateClose,
  // Remember the gap so it is never traded twice.
  onFilled(ctx, candidate) {
    if (candidate.evaluation?.gapTime != null) (symbolState(ctx.state, candidate.symbol).gapsTraded ||= {})[candidate.evaluation.gapTime] = true;
  }
};
