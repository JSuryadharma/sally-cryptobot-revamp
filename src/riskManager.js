// Portfolio-level risk management - v4 in the revamp benchmark ladder. Does
// not exist in the live app's original logic at all. Three independent
// circuit breakers, checked in this order, any one of which halts NEW
// entries only - an open position's stop/target/trend-exit logic is
// completely unaffected, on purpose: a tripped breaker should never strand a
// position past its own risk plan, only stop new ones from opening.
//
//   - Daily loss cap: lose this much of the day's starting balance in one
//     day, and new entries halt until the next UTC day.
//   - Drawdown circuit breaker: fall this far off the peak balance ever
//     recorded, and new entries halt for a fixed cooldown.
//   - Consecutive-loss kill switch: this many losing trades in a row halts
//     new entries for a shorter cooldown - a "step away" forcing function
//     after a bad stretch, not a verdict on the strategy itself.
//
// Thresholds match scripts/systemBenchmark.mjs's RISK_CFG exactly, so the
// live app's behavior matches what the delivered benchmark report describes,
// adapted from the benchmark's simulated tick clock to the live app's real
// wall clock (Date.now()).
export const RISK_CFG = {
  dailyLossCapPct: 0.04,
  drawdownBreakerPct: 0.16,
  drawdownHaltDays: 5,
  consecutiveLossLimit: 6,
  consecutiveLossHaltMs: 24 * 60 * 60_000
};

const DAY_MS = 86_400_000;
const MAX_EVENTS_KEPT = 50;

function dayKeyOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Advances the risk state's day/peak bookkeeping against the CURRENT
// portfolio balance and, if nothing is currently halted, checks all three
// breaker conditions - mirrors scripts/systemBenchmark.mjs's per-tick risk
// block. Mutates `risk` in place (same convention as the entry/exit state
// objects in liveStrategy.js) and returns { haltedUntilMs, haltReason } for
// the caller to act on immediately without re-reading the object.
export function tickRisk(risk, balanceIdr, nowMs = Date.now()) {
  const dayKey = dayKeyOf(nowMs);
  if (dayKey !== risk.dayKey) {
    risk.dayKey = dayKey;
    risk.dayStartBalanceIdr = balanceIdr;
  }
  if (risk.peakBalanceIdr == null) risk.peakBalanceIdr = balanceIdr;
  risk.peakBalanceIdr = Math.max(risk.peakBalanceIdr, balanceIdr);

  if (risk.haltedUntilMs && nowMs >= risk.haltedUntilMs) {
    risk.haltedUntilMs = null;
    risk.haltReason = null;
  }

  if (!risk.haltedUntilMs) {
    const dailyLossPct = risk.dayStartBalanceIdr > 0 ? (risk.dayStartBalanceIdr - balanceIdr) / risk.dayStartBalanceIdr : 0;
    const drawdownPct = risk.peakBalanceIdr > 0 ? (risk.peakBalanceIdr - balanceIdr) / risk.peakBalanceIdr : 0;

    if (dailyLossPct >= RISK_CFG.dailyLossCapPct) {
      const nextDayStart = new Date(`${dayKey}T00:00:00.000Z`).getTime() + DAY_MS;
      risk.haltedUntilMs = nextDayStart;
      risk.haltReason = `daily loss cap hit (${(dailyLossPct * 100).toFixed(1)}% >= ${RISK_CFG.dailyLossCapPct * 100}%)`;
      pushEvent(risk, nowMs, risk.haltReason);
    } else if (drawdownPct >= RISK_CFG.drawdownBreakerPct) {
      risk.haltedUntilMs = nowMs + RISK_CFG.drawdownHaltDays * DAY_MS;
      risk.haltReason = `drawdown circuit breaker hit (${(drawdownPct * 100).toFixed(1)}% >= ${RISK_CFG.drawdownBreakerPct * 100}%)`;
      pushEvent(risk, nowMs, risk.haltReason);
    } else if (risk.consecutiveLosses >= RISK_CFG.consecutiveLossLimit) {
      risk.haltedUntilMs = nowMs + RISK_CFG.consecutiveLossHaltMs;
      risk.haltReason = `consecutive-loss kill switch (${risk.consecutiveLosses} losers in a row)`;
      pushEvent(risk, nowMs, risk.haltReason);
      risk.consecutiveLosses = 0;
    }
  }

  return { haltedUntilMs: risk.haltedUntilMs, haltReason: risk.haltReason };
}

function pushEvent(risk, atMs, reason) {
  risk.events = [...(risk.events || []), { atMs, reason }].slice(-MAX_EVENTS_KEPT);
}

// Call once per closed trade (after closePosition() succeeds) with its
// realizedProfitIdr - resets the streak on any non-loss, increments it on a
// loss or scratch (<=0), exactly like scripts/systemBenchmark.mjs's own
// `risk.consecutiveLosses = pl <= 0 ? risk.consecutiveLosses + 1 : 0`.
export function recordTradeOutcome(risk, realizedProfitIdr) {
  risk.consecutiveLosses = realizedProfitIdr <= 0 ? (risk.consecutiveLosses || 0) + 1 : 0;
}
