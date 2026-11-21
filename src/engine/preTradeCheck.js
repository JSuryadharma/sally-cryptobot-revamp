// Last gate before a paper order, ported from the risk manager of
// github.com/Jakeschincariol/day-trader-skill (trader-risk/check.py), rewritten
// in JS for this engine. Every entry is checked against the account as if
// earlier entries had filled. Each limit is off when null.
//
// cfg.preTrade:
//   minRewardRisk       (target - entry - costs) / (entry - stop + costs) must reach this
//   maxLossPerTradePct  a trade's risk may not exceed this % of book equity
//   maxDailyRiskPct     risk opened today (this market) may not exceed this % of book equity
//   maxTradesPerDay     new entries per local day (this market)
//   cashBufferPct       cash left after the buy must stay above this % of book equity
//
// Both markets use them: crypto via config.js skillGate() (default since
// 2026-11-21), IDX via markets/idx.js.
import { profileTargetR } from './config.js';
import { bookEquityIdr } from './sizing.js';
import { localDayKey } from './riskGuard.js';

function today(state, nowMs, cfg) {
  const dayKey = localDayKey(nowMs, cfg.timeZone);
  if (state.preTrade?.dayKey !== dayKey) state.preTrade = { dayKey, trades: 0, riskIdr: 0 };
  return state.preTrade;
}

export function rewardRisk({ entryPrice, stopPrice, targetPrice, targetR, roundTripCostPct = 0 }) {
  const risk = entryPrice - stopPrice;
  if (!(risk > 0)) return null;
  const target = targetPrice ?? (targetR ? entryPrice + targetR * risk : null);
  if (target == null) return null;
  const cost = (entryPrice * roundTripCostPct) / 100;
  return (target - entryPrice - cost) / (risk + cost);
}

// Returns { ok, reason, checks: [{ key, ok, detail }] }.
export function preTradeCheck({ state, portfolio, cfg, profile, entryPrice, stopPrice, targetPrice, qty, riskIdr, usdIdrRate, nowMs }) {
  const limits = cfg.preTrade;
  const checks = [];
  if (!limits) return { ok: true, reason: null, checks };
  const equity = bookEquityIdr(portfolio);
  const day = today(state, nowMs, cfg);
  const add = (key, ok, detail) => { checks.push({ key, ok, detail }); return ok; };

  if (limits.minRewardRisk != null) {
    const rr = rewardRisk({ entryPrice, stopPrice, targetPrice, targetR: profileTargetR(profile, cfg), roundTripCostPct: cfg.roundTripCostPct });
    add('rewardRisk', rr == null || rr >= limits.minRewardRisk, `reward:risk ${rr == null ? 'n/a' : rr.toFixed(2)} (min ${limits.minRewardRisk})`);
  }
  if (limits.maxLossPerTradePct != null) {
    const cap = (equity * limits.maxLossPerTradePct) / 100;
    add('maxLoss', riskIdr <= cap + 0.01, `trade risk Rp ${Math.round(riskIdr).toLocaleString('id-ID')} (max ${limits.maxLossPerTradePct}% = Rp ${Math.round(cap).toLocaleString('id-ID')})`);
  }
  if (limits.maxDailyRiskPct != null) {
    const cap = (equity * limits.maxDailyRiskPct) / 100;
    add('dailyRisk', day.riskIdr + riskIdr <= cap + 0.01, `risk opened today would be ${((100 * (day.riskIdr + riskIdr)) / Math.max(equity, 1)).toFixed(1)}% (max ${limits.maxDailyRiskPct}%)`);
  }
  if (limits.maxTradesPerDay != null) {
    add('tradesPerDay', day.trades < limits.maxTradesPerDay, `${day.trades} entries today (max ${limits.maxTradesPerDay})`);
  }
  if (limits.cashBufferPct != null) {
    const spend = qty * entryPrice * usdIdrRate * (1 + cfg.roundTripCostPct / 200);
    const left = portfolio.balanceIdr - spend;
    add('cashBuffer', left >= (equity * limits.cashBufferPct) / 100, `cash after buy ${((100 * left) / Math.max(equity, 1)).toFixed(1)}% of equity (min ${limits.cashBufferPct}%)`);
  }
  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed ? `pre-trade check: ${failed.detail}` : null, checks };
}

export function recordEntry(state, riskIdr, nowMs, cfg) {
  if (!cfg.preTrade) return;
  const day = today(state, nowMs, cfg);
  day.trades += 1;
  day.riskIdr += riskIdr || 0;
}
