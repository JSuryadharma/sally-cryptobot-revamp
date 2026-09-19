#!/usr/bin/env node
// Backtest Expert evaluation script - rewritten for robocrypto from
// https://github.com/tradermonty/claude-trading-skills (skills/backtest-expert,
// originally Python). Same 5-dimension scoring framework (Sample Size,
// Expectancy, Risk Management, Robustness, Execution Realism), ported 1:1,
// plus one addition: --summary reads a scripts/benchmark.mjs report
// directly instead of requiring every metric typed out by hand.
//
// Run against manual metrics (matches the original CLI):
//   node .claude/skills/backtest-expert/scripts/evaluate_backtest.mjs \
//     --total-trades 150 --win-rate 62 --avg-win-pct 1.8 --avg-loss-pct 1.2 \
//     --max-drawdown-pct 15 --years-tested 8 --num-parameters 3 --slippage-tested \
//     --output-dir reports/
//
// Run against a robocrypto benchmark report directly:
//   node .claude/skills/backtest-expert/scripts/evaluate_backtest.mjs \
//     --summary benchmarks/<timestamp>/summary.json --num-parameters 2 \
//     --output-dir reports/

import fs from 'node:fs/promises';
import path from 'node:path';
import { readSettings } from '../../../../src/settings.js';

function clampScore(v) { return Math.max(0, Math.min(100, v)); }

// --- scoring functions (each 0-20, ported from evaluate_backtest.py) -------

function scoreSampleSize(totalTrades) {
  if (totalTrades < 30) return 0;
  if (totalTrades < 100) return 8 + Math.floor(((totalTrades - 30) / 70) * 7);
  if (totalTrades < 200) return 15 + Math.floor(((totalTrades - 100) / 100) * 5);
  return 20;
}

function calcProfitFactor(winRate, avgWinPct, avgLossPct) {
  const wr = winRate / 100;
  const lossComponent = (1 - wr) * avgLossPct;
  if (lossComponent === 0) return Infinity;
  return (wr * avgWinPct) / lossComponent;
}

function calcExpectancy(winRate, avgWinPct, avgLossPct) {
  const wr = winRate / 100;
  return wr * avgWinPct - (1 - wr) * avgLossPct;
}

function scoreExpectancy(winRate, avgWinPct, avgLossPct) {
  const exp = calcExpectancy(winRate, avgWinPct, avgLossPct);
  if (exp <= 0) return 0;
  if (exp < 0.5) return 5 + Math.floor((exp / 0.5) * 5);
  if (exp < 1.5) return 10 + Math.floor(((exp - 0.5) / 1.0) * 8);
  return 20;
}

function scoreRiskManagement(maxDrawdownPct, winRate, avgWinPct, avgLossPct) {
  if (maxDrawdownPct >= 50) return 0;
  const ddScore = maxDrawdownPct < 20 ? 12 : Math.floor(12 * ((50 - maxDrawdownPct) / 30));
  const pf = calcProfitFactor(winRate, avgWinPct, avgLossPct);
  let pfScore;
  if (pf < 1.0) pfScore = 0;
  else if (pf >= 3.0) pfScore = 8;
  else pfScore = Math.floor(((pf - 1.0) / 2.0) * 8);
  return Math.min(20, ddScore + pfScore);
}

function scoreRobustness(yearsTested, numParameters) {
  let yearsScore;
  if (yearsTested < 5) yearsScore = 0;
  else if (yearsTested >= 10) yearsScore = 15;
  else yearsScore = 5 + Math.floor(((yearsTested - 5) / 5) * 10);
  let paramScore;
  if (numParameters <= 4) paramScore = 5;
  else if (numParameters <= 6) paramScore = 3;
  else if (numParameters === 7) paramScore = 1;
  else paramScore = 0;
  return Math.min(20, yearsScore + paramScore);
}

function scoreExecutionRealism(slippageTested) { return slippageTested ? 20 : 0; }

function getVerdict(totalScore) {
  if (totalScore >= 70) return 'Deploy';
  if (totalScore >= 40) return 'Refine';
  return 'Abandon';
}

function detectRedFlags({ totalTrades, winRate, avgWinPct, avgLossPct, maxDrawdownPct, yearsTested, numParameters, slippageTested }) {
  const flags = [];
  if (totalTrades < 30) flags.push({ id: 'small_sample', severity: 'high', message: `Only ${totalTrades} trades - minimum 30 required for statistical confidence.` });
  if (!slippageTested) flags.push({ id: 'no_slippage_test', severity: 'high', message: 'Slippage/friction not tested - results may not survive real-world execution.' });
  if (maxDrawdownPct > 50) flags.push({ id: 'excessive_drawdown', severity: 'high', message: `Max drawdown ${maxDrawdownPct}% exceeds 50% threshold - catastrophic risk.` });
  if (numParameters >= 7) flags.push({ id: 'over_optimized', severity: 'medium', message: `${numParameters} parameters suggests over-optimization / curve-fitting risk.` });
  if (yearsTested < 5) flags.push({ id: 'short_test_period', severity: 'medium', message: `Only ${yearsTested} years tested - may miss regime changes (minimum 5 recommended).` });
  const exp = calcExpectancy(winRate, avgWinPct, avgLossPct);
  if (exp < 0) flags.push({ id: 'negative_expectancy', severity: 'high', message: `Negative expectancy (${exp.toFixed(3)}%) - strategy loses money on average.` });
  if (winRate > 90 && maxDrawdownPct < 5) flags.push({ id: 'too_good', severity: 'medium', message: 'Results look too good - audit for look-ahead bias or data issues.' });
  return flags;
}

function validateInputs({ totalTrades, winRate, avgWinPct, avgLossPct, maxDrawdownPct, yearsTested, numParameters }) {
  if (totalTrades < 0) throw new Error('total_trades must be >= 0');
  if (!(winRate >= 0 && winRate <= 100)) throw new Error('win_rate must be between 0 and 100');
  if (avgWinPct < 0) throw new Error('avg_win_pct must be >= 0');
  if (avgLossPct < 0) throw new Error('avg_loss_pct must be >= 0');
  if (maxDrawdownPct < 0) throw new Error('max_drawdown_pct must be >= 0');
  if (yearsTested < 0) throw new Error('years_tested must be >= 0');
  if (numParameters < 0) throw new Error('num_parameters must be >= 0');
}

export function evaluate(inputs) {
  validateInputs(inputs);
  const { totalTrades, winRate, avgWinPct, avgLossPct, maxDrawdownPct, yearsTested, numParameters, slippageTested } = inputs;
  const d1 = scoreSampleSize(totalTrades);
  const d2 = scoreExpectancy(winRate, avgWinPct, avgLossPct);
  const d3 = scoreRiskManagement(maxDrawdownPct, winRate, avgWinPct, avgLossPct);
  const d4 = scoreRobustness(yearsTested, numParameters);
  const d5 = scoreExecutionRealism(slippageTested);
  const total = clampScore(d1 + d2 + d3 + d4 + d5);
  return {
    total_score: total,
    verdict: getVerdict(total),
    dimensions: [
      { name: 'Sample Size', score: d1, max_score: 20 },
      { name: 'Expectancy', score: d2, max_score: 20 },
      { name: 'Risk Management', score: d3, max_score: 20 },
      { name: 'Robustness', score: d4, max_score: 20 },
      { name: 'Execution Realism', score: d5, max_score: 20 }
    ],
    red_flags: detectRedFlags(inputs),
    profit_factor: calcProfitFactor(winRate, avgWinPct, avgLossPct),
    expectancy: calcExpectancy(winRate, avgWinPct, avgLossPct),
    inputs: { total_trades: totalTrades, win_rate: winRate, avg_win_pct: avgWinPct, avg_loss_pct: avgLossPct, max_drawdown_pct: maxDrawdownPct, years_tested: yearsTested, num_parameters: numParameters, slippage_tested: slippageTested }
  };
}

function toMarkdown(result) {
  const lines = [
    '# Backtest Evaluation Report', '',
    `**Generated**: ${new Date().toISOString()}`, '',
    `## Verdict: ${result.verdict}`, '',
    `**Total Score: ${result.total_score} / 100**`, '',
    '## Dimension Scores', '',
    '| Dimension | Score | Max |', '|-----------|------:|----:|'
  ];
  for (const dim of result.dimensions) lines.push(`| ${dim.name} | ${dim.score} | ${dim.max_score} |`);
  lines.push('', '## Key Metrics', '');
  lines.push(result.profit_factor === Infinity ? '- **Profit Factor**: Inf (no losing trades)' : `- **Profit Factor**: ${result.profit_factor.toFixed(2)}`);
  lines.push(`- **Expectancy**: ${result.expectancy.toFixed(3)}% per trade`);
  if (result.red_flags.length) {
    lines.push('', '## Red Flags', '');
    for (const flag of result.red_flags) lines.push(`- ${flag.severity === 'high' ? '\u{1F534}' : '\u{1F7E1}'} **${flag.id}**: ${flag.message}`);
  } else {
    lines.push('', '## Red Flags', '', 'No red flags detected.');
  }
  lines.push('', '## Input Parameters', '');
  for (const [key, value] of Object.entries(result.inputs)) lines.push(`- **${key}**: ${value}`);
  lines.push('');
  return lines.join('\n');
}

async function writeOutputs(result, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stem = `backtest_eval_${stamp}`;
  const jsonPath = path.join(outputDir, `${stem}.json`);
  const mdPath = path.join(outputDir, `${stem}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(result, (_, v) => (v === Infinity ? 'Infinity' : v), 2));
  await fs.writeFile(mdPath, toMarkdown(result));
  return { jsonPath, mdPath };
}

// --- robocrypto-native convenience: read a benchmark.mjs summary.json ------
//
// summary.json's fields (see scripts/benchmark.mjs summarize()) are IDR
// amounts and trade counts, not %-of-position returns, so avg_win_pct/
// avg_loss_pct here are an approximation: avg win|loss IDR divided by one
// trade's position size (tradeAllocationPct * initialBalanceIdr, read from
// the DB-backed settings - see settings.js - since it's no longer an env
// var). Good enough for a directional Deploy/Refine/Abandon read, not exact
// per-trade %, since balance (and so position size) drifts trade to trade -
// flagged plainly in the printed output so it's never mistaken for exact.
async function fromBenchmarkSummary(summaryPath, { numParameters, slippageTested }) {
  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
  const windowStartMs = new Date(summary.windowStart).getTime();
  const windowEndMs = new Date(summary.windowEnd).getTime();
  const yearsTested = Math.round(((windowEndMs - windowStartMs) / (365 * 86_400_000)) * 1000) / 1000;
  const settings = await readSettings().catch(() => null);
  const tradeAllocationPct = settings?.tradeAllocationPct ?? 0.3;
  const positionSizeIdr = summary.initialBalanceIdr * tradeAllocationPct;
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    totalTrades: summary.closedTrades,
    winRate: summary.winRate ?? 0,
    avgWinPct: positionSizeIdr > 0 ? round2((summary.avgWinIdr / positionSizeIdr) * 100) : 0,
    avgLossPct: positionSizeIdr > 0 ? round2((Math.abs(summary.avgLossIdr) / positionSizeIdr) * 100) : 0,
    maxDrawdownPct: summary.maxDrawdownPct,
    yearsTested,
    numParameters: numParameters ?? 2, // robocrypto's own knobs: confidence threshold + RR template
    slippageTested: slippageTested ?? true // benchmark.mjs always applies roundTripCostPct
  };
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { outputDir: 'reports/' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--total-trades') opts.totalTrades = Number(argv[++i]);
    else if (a === '--win-rate') opts.winRate = Number(argv[++i]);
    else if (a === '--avg-win-pct') opts.avgWinPct = Number(argv[++i]);
    else if (a === '--avg-loss-pct') opts.avgLossPct = Number(argv[++i]);
    else if (a === '--max-drawdown-pct') opts.maxDrawdownPct = Number(argv[++i]);
    else if (a === '--years-tested') opts.yearsTested = Number(argv[++i]);
    else if (a === '--num-parameters') opts.numParameters = Number(argv[++i]);
    else if (a === '--slippage-tested') opts.slippageTested = true;
    else if (a === '--output-dir') opts.outputDir = argv[++i];
    else if (a === '--summary') opts.summaryPath = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let inputs;
  if (opts.summaryPath) {
    inputs = await fromBenchmarkSummary(opts.summaryPath, { numParameters: opts.numParameters, slippageTested: opts.slippageTested });
    console.log(`Loaded from ${opts.summaryPath}: ${inputs.totalTrades} trades, win rate ${inputs.winRate}%, avg win/loss %s are an approximation (see script comment) - pass --avg-win-pct/--avg-loss-pct to override.`);
  } else {
    inputs = opts;
  }
  const required = ['totalTrades', 'winRate', 'avgWinPct', 'avgLossPct', 'maxDrawdownPct', 'yearsTested', 'numParameters'];
  const missing = required.filter((k) => inputs[k] === undefined || Number.isNaN(inputs[k]));
  if (missing.length) {
    console.error(`Missing required inputs: ${missing.join(', ')}\nEither pass --summary <benchmark summary.json> or all of: --total-trades --win-rate --avg-win-pct --avg-loss-pct --max-drawdown-pct --years-tested --num-parameters`);
    process.exitCode = 1;
    return;
  }
  inputs.slippageTested = Boolean(inputs.slippageTested);

  const result = evaluate(inputs);
  const { jsonPath, mdPath } = await writeOutputs(result, opts.outputDir);
  console.log(`Score: ${result.total_score}/100 - Verdict: ${result.verdict}`);
  if (result.red_flags.length) {
    console.log(`Red flags: ${result.red_flags.length}`);
    for (const flag of result.red_flags) console.log(`  [${flag.severity.toUpperCase()}] ${flag.message}`);
  }
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('\nevaluate_backtest failed:', err.message);
    process.exitCode = 1;
  });
}
