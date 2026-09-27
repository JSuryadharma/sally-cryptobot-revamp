// Lets the dashboard run a short v2 backtest (scripts/backtest.mjs, the same
// engine code that trades live) and stores the backtest-expert verdict.
import { runBacktest } from '../scripts/backtest.mjs';
import { evaluate } from '../.claude/skills/backtest-expert/scripts/evaluate_backtest.mjs';
import { writeJson } from './storage.js';

export const VERDICT_KEY = 'backtest-verdict.json';

function toEvaluatorInputs(summary, { tradeAllocationPct }) {
  const yearsTested = Math.round(((Date.parse(summary.windowEnd) - Date.parse(summary.windowStart)) / (365 * 86_400_000)) * 1000) / 1000;
  const positionSizeIdr = summary.initialBalanceIdr * tradeAllocationPct;
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    totalTrades: summary.closedTrades,
    winRate: summary.winRate ?? 0,
    avgWinPct: positionSizeIdr > 0 ? round2((summary.avgWinIdr / positionSizeIdr) * 100) : 0,
    avgLossPct: positionSizeIdr > 0 ? round2((Math.abs(summary.avgLossIdr) / positionSizeIdr) * 100) : 0,
    maxDrawdownPct: summary.maxDrawdownPct,
    yearsTested,
    numParameters: 3,
    slippageTested: true
  };
}

export async function runAndStoreBacktest({ symbols, months, baseUrl, engineCfg, tradeAllocationPct = 0.3 }) {
  const { metrics } = await runBacktest({ symbols, months, baseUrl, engineCfg });
  const result = evaluate(toEvaluatorInputs(metrics, { tradeAllocationPct }));
  const payload = {
    available: true,
    generatedAtIso: new Date().toISOString(),
    totalScore: result.total_score,
    verdict: result.verdict,
    redFlags: (result.red_flags || []).map((f) => ({ severity: f.severity, message: f.message })),
    inputs: result.inputs,
    benchmarkSummary: {
      windowStart: metrics.windowStart, windowEnd: metrics.windowEnd,
      totalReturnPct: metrics.totalReturnPct, closedTrades: metrics.closedTrades,
      winRate: metrics.winRate, profitFactor: metrics.profitFactor, maxDrawdownPct: metrics.maxDrawdownPct,
      expectancyR: metrics.expectancyR, openAtEnd: metrics.openAtEnd?.length ?? 0,
      symbols, months
    }
  };
  await writeJson(VERDICT_KEY, payload);
  return payload;
}
