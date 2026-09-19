// Glue between scripts/benchmark.mjs (the walk-forward backtest) and the
// .claude/skills/backtest-expert evaluator, so the app itself can trigger a
// backtest and store a verdict - not just read one written by a CLI run.
// Both entry points (this, and the CLI skill script) write to the same
// storage key, so the dashboard shows whichever ran most recently either way.
import { runBacktest, summarize } from '../scripts/benchmark.mjs';
import { evaluate } from '../.claude/skills/backtest-expert/scripts/evaluate_backtest.mjs';
import { writeJson } from './storage.js';

const VERDICT_KEY = 'backtest-verdict.json';

// Same approximation the backtest-expert skill's fromBenchmarkSummary() uses
// when reading a summary.json off disk - avg win/loss %s are derived from
// IDR amounts via tradeAllocationPct since summarize() reports currency, not
// %-of-position returns.
function toEvaluatorInputs(summary, { numParameters, slippageTested, tradeAllocationPct }) {
  const windowStartMs = new Date(summary.windowStart).getTime();
  const windowEndMs = new Date(summary.windowEnd).getTime();
  const yearsTested = Math.round(((windowEndMs - windowStartMs) / (365 * 86_400_000)) * 1000) / 1000;
  const positionSizeIdr = summary.initialBalanceIdr * tradeAllocationPct;
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    totalTrades: summary.closedTrades,
    winRate: summary.winRate ?? 0,
    avgWinPct: positionSizeIdr > 0 ? round2((summary.avgWinIdr / positionSizeIdr) * 100) : 0,
    avgLossPct: positionSizeIdr > 0 ? round2((Math.abs(summary.avgLossIdr) / positionSizeIdr) * 100) : 0,
    maxDrawdownPct: summary.maxDrawdownPct,
    yearsTested,
    numParameters: numParameters ?? 3, // confidence threshold + RR template + ADX floor - robocrypto's actual tuned knobs
    slippageTested: slippageTested ?? true // benchmark.mjs always applies roundTripCostPct
  };
}

// Persisted (and returned to the caller) in the same shape server.js's
// GET /api/backtest-verdict has always served, so the frontend needs no changes.
function toVerdictPayload(result, { generatedAtIso, benchmarkSummary }) {
  return {
    available: true,
    generatedAtIso,
    totalScore: result.total_score,
    verdict: result.verdict,
    redFlags: (result.red_flags || []).map((f) => ({ severity: f.severity, message: f.message })),
    inputs: result.inputs,
    benchmarkSummary // extra: the raw benchmark numbers (return %, trades, window) for the UI to show alongside the score
  };
}

export async function runAndStoreBacktest({
  symbols, months, minConfidencePct, riskRewardTemplate, numParameters, endTime, baseUrl,
  initialBalanceIdr, usdIdrRate, tradeAllocationPct, maxOpenPositions, roundTripCostPct
}) {
  const backtest = await runBacktest({
    symbols, months, minConfidencePct, riskRewardTemplate, endTime: endTime ?? Date.now(), baseUrl,
    initialBalanceIdr, usdIdrRate, tradeAllocationPct, maxOpenPositions, roundTripCostPct
  });
  const summary = summarize({ ...backtest, usdIdrRate });
  const evaluatorInputs = toEvaluatorInputs(summary, { numParameters, tradeAllocationPct: tradeAllocationPct ?? 0.3 });
  const result = evaluate(evaluatorInputs);
  const payload = toVerdictPayload(result, {
    generatedAtIso: new Date().toISOString(),
    benchmarkSummary: {
      windowStart: summary.windowStart, windowEnd: summary.windowEnd,
      totalReturnPct: summary.totalReturnPct, closedTrades: summary.closedTrades,
      winRate: summary.winRate, profitFactor: summary.profitFactor, maxDrawdownPct: summary.maxDrawdownPct,
      symbols, months, minConfidencePct, riskRewardTemplate
    }
  });
  await writeJson(VERDICT_KEY, payload);
  return payload;
}

export { VERDICT_KEY };
