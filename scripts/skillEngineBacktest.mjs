// The live crypto robot with and without day-trader-skill's pre-trade risk
// gate (src/engine/preTradeCheck.js), through the real engine (advance() +
// autopilot) on one account. Same flags as scripts/gapSleeveBacktest.mjs.
//
//   node scripts/skillEngineBacktest.mjs --months 36 --end 2026-11-15
import { resolveEngineCfg, DEFAULT_ENGINE_CFG } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';

const MONTH_MS = 30 * 86_400_000;
const risk = DEFAULT_ENGINE_CFG.riskPerTradePct;
export const GATES = {
  'robot (live)': null,
  'robot + skill gate': { minRewardRisk: 1, maxLossPerTradePct: Math.max(risk * 1.25, 0.5), maxDailyRiskPct: 6, maxTradesPerDay: 3, cashBufferPct: 10 },
  // Same limits without the reward:risk rule, which on its own blocks the 20-day breakout's +1R target.
  'robot + skill gate, no R:R rule': { minRewardRisk: null, maxLossPerTradePct: Math.max(risk * 1.25, 0.5), maxDailyRiskPct: 6, maxTradesPerDay: 3, cashBufferPct: 10 },
  'robot + strict skill gate': { minRewardRisk: 1.5, maxLossPerTradePct: Math.max(risk * 1.25, 0.5), maxDailyRiskPct: 4, maxTradesPerDay: 2, cashBufferPct: 20 }
};

function parseArgs(argv) {
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const args = { months: 36, symbols: DEFAULT_SYMBOLS, end, cost: 0.2, slip: 0.05, cache: true, split: Date.parse('2025-09-10') };
  for (let k = 0; k < argv.length; k += 1) {
    const [flag, value] = [argv[k], argv[k + 1]];
    if (flag === '--months') { args.months = Number(value); k += 1; }
    else if (flag === '--end') { args.end = Date.parse(value); k += 1; }
    else if (flag === '--split') { args.split = Date.parse(value); k += 1; }
    else if (flag === '--cost') { args.cost = Number(value); k += 1; }
    else if (flag === '--slip') { args.slip = Number(value); k += 1; }
    else if (flag === '--symbols') { args.symbols = value.split(','); k += 1; }
    else if (flag === '--no-cache') args.cache = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Loading ${args.symbols.length} coins, ${day(startMs)} -> ${day(args.end)}...`);
  const series = await loadSeries({ symbols: args.symbols, startMs, endMs: args.end, useCache: args.cache, log: () => {} });
  const base = { roundTripCostPct: args.cost, slippagePct: args.slip };
  const rows = [];
  for (const [label, from, to] of [['all', startMs, args.end], ['train', startMs, args.split], ['test', args.split, args.end]]) {
    for (const [name, gate] of Object.entries(GATES).filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
      const cfg = resolveEngineCfg(base);
      cfg.preTrade = gate;
      const { metrics: m } = simulate(series, { symbols: args.symbols, startMs: from, endMs: to, autopilot: true, cfg });
      rows.push({ window: `${label} ${day(from)}..${day(to)}`, run: name, returnPct: m.totalReturnPct, maxDdPct: m.maxDrawdownPct, trades: m.closedTrades, winPct: m.winRate, avgR: m.expectancyR, pf: m.profitFactor });
    }
  }
  console.table(rows);
  console.log(JSON.stringify(rows));
}

main().catch((err) => { console.error(err); process.exit(1); });
