// The autopilot picks the live strategy on every engine pass, so there are no
// strategy switches to set by hand. Pure: the live tick and the backtester
// both call decideStrategy().
//
// Candidates are the two daily breakouts that made money on both research
// periods (scripts/entryResearch.mjs, 2026-09-28). The pullback profiles
// (swing, trend, scalping) lost on the test period and are never picked.
//
// The evidence is the paper test (paperBreakout.js): every breakout signal on
// the watchlist, followed as if traded, whether or not the engine bought it.
// For each candidate the autopilot looks at its last WINDOW closed paper
// trades after costs:
// - fewer than MIN_CLOSED: "learning", tradeable;
// - average at or below BENCH_BELOW_R: "benched", not traded;
// - otherwise "ok".
// It trades the first candidate in CANDIDATES order that is not benched: the
// 55-day breakout, with the 20-day as the fallback. It does not chase whichever
// rule did better lately: in the 24-month backtest (2024-10 to 2026-10, 15
// coins) switching to the recent leader returned +2.5% against +13.3% for the
// 55-day breakout alone, because each switch came after the leader's good run.
// When every candidate is benched it pauses new entries, keeps the first
// profile on so signals are still recorded, and resumes once the paper results
// recover. BTC under its 200-day average blocks the breakout entries on its
// own; the autopilot only reports it.
import { btcAbove200d } from './paperBreakout.js';
import { PROFILES } from './config.js';

export const AUTOPILOT_PARAMS = {
  window: 20,
  minClosed: 12,
  benchBelowR: -0.15,
  // Position size follows the evidence: full risk only while the traded rule's
  // last WINDOW paper trades average at least fullRiskFromR, otherwise
  // reducedRiskScale of it (still learning, or proven but only marginal).
  fullRiskFromR: 0.2,
  reducedRiskScale: 0.5
};

// In priority order. Research: the entry research test period (2025-07 to
// 2026-09). Backtest: backtest.mjs --auto, 24 months to 2026-10-05, 0.2% cost.
export const CANDIDATES = [
  { profile: 'breakout55', rule: 'breakout55', research: '+0.37R a trade over 31 trades on the research test period, +0.32R over 53 in the 24-month backtest' },
  { profile: 'breakout', rule: 'breakout20', research: '+0.21R a trade over 54 trades on the research test period, +0.11R over 84 in the 24-month backtest' }
];

export const RETIRED = {
  swing: 'Pullback on 4h candles: lost money on the research test period.',
  trend: 'Pullback on daily candles: lost money on the research test period.',
  scalping: 'Lost money in every backtest after costs.'
};

const BTC_SMA_DAYS = 200;

function round2(v) { return Math.round(v * 100) / 100; }

function regimeAt(btcDaily, nowMs) {
  if (!btcDaily?.length) return { known: false, btcAbove200d: false, btcClose: null, sma200: null };
  let j = btcDaily.length - 1;
  while (j >= 0 && btcDaily[j].time * 1000 > nowMs) j -= 1;
  if (j < BTC_SMA_DAYS - 1) return { known: false, btcAbove200d: false, btcClose: btcDaily[j]?.close ?? null, sma200: null };
  let sum = 0;
  for (let k = j - BTC_SMA_DAYS + 1; k <= j; k += 1) sum += btcDaily[k].close;
  return {
    known: true,
    btcAbove200d: btcAbove200d(btcDaily, btcDaily[j].time),
    btcClose: btcDaily[j].close,
    sma200: round2(sum / BTC_SMA_DAYS),
    asOf: new Date(btcDaily[j].time * 1000).toISOString().slice(0, 10)
  };
}

function candidateStats(candidate, known, params) {
  const recent = known.filter((x) => x.rule === candidate.rule).slice(0, params.window);
  const closed = recent.length;
  const avgR = closed ? round2(recent.reduce((s, x) => s + x.r, 0) / closed) : null;
  const winPct = closed ? round2((recent.filter((x) => x.r > 0).length / closed) * 100) : null;
  let status = 'ok';
  if (closed < params.minClosed) status = 'learning';
  else if (avgR <= params.benchBelowR) status = 'benched';
  const p = PROFILES[candidate.profile];
  return {
    profile: candidate.profile, rule: candidate.rule, label: p.label,
    lookback: p.breakoutLookback, targetR: p.targetR, research: candidate.research,
    closed, avgR, winPct, status
  };
}

const describe = (c) => `${c.lookback}-day breakout`;

// results: paperResults() output, any order.
export function decideStrategy({ results, btcDaily, nowMs, params = AUTOPILOT_PARAMS }) {
  const known = results.filter((x) => x.closedAtMs <= nowMs).sort((a, b) => b.closedAtMs - a.closedAtMs);
  const candidates = CANDIDATES.map((c) => candidateStats(c, known, params));
  const chosen = candidates.find((c) => c.status !== 'benched') || null;
  let why;
  if (!chosen) {
    why = `every breakout is losing in the paper test (last ${params.window} closed trades at or below ${params.benchBelowR}R)`;
  } else if (chosen !== candidates[0]) {
    why = `the ${describe(candidates[0])} is benched (last ${params.window} paper trades average ${candidates[0].avgR}R), so the fallback trades`;
  } else if (chosen.status === 'learning') {
    why = `the strongest rule in the backtests; ${chosen.closed} of ${params.minClosed} paper trades closed so far`;
  } else {
    why = `the strongest rule in the backtests, ${chosen.avgR >= 0 ? '+' : ''}${chosen.avgR}R a trade over its last ${chosen.closed} paper trades`;
  }

  const paused = !chosen;
  const active = chosen || candidates[0];
  const fullRisk = active.status === 'ok' && active.avgR >= params.fullRiskFromR;
  const riskScale = fullRisk ? 1 : params.reducedRiskScale;
  const sizing = fullRisk
    ? `full size: its last ${active.closed} paper trades average +${active.avgR}R`
    : `half size until its last ${params.window} paper trades average at least +${params.fullRiskFromR}R`;
  const profiles = Object.fromEntries(Object.keys(PROFILES).map((key) => [key, key === active.profile]));
  const regime = regimeAt(btcDaily, nowMs);

  let summary;
  if (paused) summary = `New buys are paused: ${why}. The paper test keeps running and buying resumes once a breakout recovers.`;
  else if (regime.known && !regime.btcAbove200d) summary = `Trading the ${describe(active)} (${why}). Bitcoin is below its 200-day average, so no new buys until it climbs back above.`;
  else summary = `Trading the ${describe(active)}, selling at +${active.targetR}R: ${why}. Buying at ${sizing}.`;

  return {
    version: 1,
    decidedAt: new Date(nowMs).toISOString(),
    chosen: active.profile,
    paused,
    pauseReason: paused ? why : null,
    why,
    summary,
    profiles,
    riskScale,
    regime,
    candidates,
    params
  };
}

// True when the live choice changed (strategy or pause state).
export function decisionChanged(previous, next) {
  return !previous || previous.chosen !== next.chosen || Boolean(previous.paused) !== Boolean(next.paused);
}
