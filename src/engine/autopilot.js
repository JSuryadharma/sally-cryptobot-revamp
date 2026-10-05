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
// - fewer than MIN_CLOSED: "learning", eligible, ranked after proven ones;
// - average at or below BENCH_BELOW_R: "benched", not traded;
// - otherwise "ok", ranked by its average.
// It trades the best eligible candidate. A challenger has to beat the current
// choice by SWITCH_MARGIN_R, so it doesn't flip on every closed trade. When
// every candidate is benched it pauses new entries, keeps the default profile
// on so signals are still recorded, and resumes once the paper results recover.
// BTC under its 200-day average blocks the breakout entries on its own; the
// autopilot only reports it.
import { btcAbove200d } from './paperBreakout.js';
import { PROFILES } from './config.js';

export const AUTOPILOT_PARAMS = {
  window: 20,
  minClosed: 12,
  benchBelowR: -0.15,
  switchMarginR: 0.1
};

export const CANDIDATES = [
  { profile: 'breakout', rule: 'breakout20', research: '+0.21R a trade over 54 trades on the research test period' },
  { profile: 'breakout55', rule: 'breakout55', research: '+0.37R a trade over 31 trades on the research test period' }
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

// results: paperResults() output, any order. previous: the last decision, if any.
export function decideStrategy({ results, btcDaily, nowMs, previous = null, params = AUTOPILOT_PARAMS }) {
  const known = results.filter((x) => x.closedAtMs <= nowMs).sort((a, b) => b.closedAtMs - a.closedAtMs);
  const candidates = CANDIDATES.map((c) => candidateStats(c, known, params));
  const eligible = candidates.filter((c) => c.status !== 'benched');
  const proven = eligible.filter((c) => c.status === 'ok' && c.avgR > 0).sort((a, b) => b.avgR - a.avgR);

  let chosen = proven[0] || eligible[0] || null;
  let why;
  if (!chosen) {
    why = `every breakout is losing in the paper test (last ${params.window} closed trades at or below ${params.benchBelowR}R)`;
  } else if (proven[0] === chosen) {
    why = `best paper result: ${chosen.avgR >= 0 ? '+' : ''}${chosen.avgR}R a trade over its last ${chosen.closed} closed trades`;
  } else if (chosen.status === 'learning') {
    why = `not enough paper trades yet (${chosen.closed} of ${params.minClosed}) to rank, so it runs the rule with the larger research sample`;
  } else {
    why = `no breakout is ahead in the paper test, so it keeps the rule with the larger research sample`;
  }

  // Hysteresis: keep the current choice unless the challenger is clearly ahead.
  const current = previous?.chosen && eligible.find((c) => c.profile === previous.chosen);
  if (chosen && current && current !== chosen && !previous.paused) {
    const challengerAhead = chosen.status === 'ok' && (current.status === 'learning'
      ? chosen.avgR > 0
      : chosen.avgR - current.avgR >= params.switchMarginR);
    if (!challengerAhead) {
      why = `kept: the ${describe(chosen)} is not ahead of it by ${params.switchMarginR}R a trade or more`;
      chosen = current;
    }
  }

  const paused = !chosen;
  const active = chosen || candidates[0];
  const profiles = Object.fromEntries(Object.keys(PROFILES).map((key) => [key, key === active.profile]));
  const regime = regimeAt(btcDaily, nowMs);

  let summary;
  if (paused) summary = `New buys are paused: ${why}. The paper test keeps running and buying resumes once a breakout recovers.`;
  else if (regime.known && !regime.btcAbove200d) summary = `Trading the ${describe(active)} (${why}). Bitcoin is below its 200-day average, so no new buys until it climbs back above.`;
  else summary = `Trading the ${describe(active)}, selling at +${active.targetR}R: ${why}.`;

  return {
    version: 1,
    decidedAt: new Date(nowMs).toISOString(),
    chosen: active.profile,
    paused,
    pauseReason: paused ? why : null,
    why,
    summary,
    profiles,
    regime,
    candidates,
    params
  };
}

// True when the live choice changed (strategy or pause state).
export function decisionChanged(previous, next) {
  return !previous || previous.chosen !== next.chosen || Boolean(previous.paused) !== Boolean(next.paused);
}
