// The live robot with and without the gap-rebound sleeve, through the real
// engine (advance() + autopilot), on one account:
//
//   node scripts/gapSleeveBacktest.mjs --months 36 --end 2026-11-15
//
// Runs the full window plus the train/test split used in the gap research
// (split at 2025-09-10 by default). Same flags as scripts/backtest.mjs for
// --months, --end, --cost, --slip, --symbols, --no-cache; --split <ISO date>.
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';

const MONTH_MS = 30 * 86_400_000;

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

function row(name, m) {
  const gap = m.byProfile?.gap;
  return {
    run: name, returnPct: m.totalReturnPct, maxDdPct: m.maxDrawdownPct, trades: m.closedTrades, winPct: m.winRate,
    avgR: m.expectancyR, pf: m.profitFactor,
    gapTrades: gap?.trades ?? 0, gapWinPct: gap?.winRate ?? null, gapPnlIdr: gap ? Math.round(gap.pnlIdr) : 0
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Loading ${args.symbols.length} coins, ${day(startMs)} -> ${day(args.end)}...`);
  const series = await loadSeries({ symbols: args.symbols, startMs, endMs: args.end, useCache: args.cache, log: (m) => console.log(m) });
  const base = { roundTripCostPct: args.cost, slippagePct: args.slip };
  const windows = [['all', startMs, args.end], ['train', startMs, args.split], ['test', args.split, args.end]];
  const rows = [];
  for (const [label, from, to] of windows) {
    for (const gap of [false, true]) {
      const { metrics } = simulate(series, { symbols: args.symbols, startMs: from, endMs: to, autopilot: true, cfg: resolveEngineCfg({ ...base, profiles: { gap } }) });
      rows.push({ window: `${label} ${day(from)}..${day(to)}`, ...row(gap ? 'robot + gap sleeve' : 'robot only', metrics) });
    }
  }
  console.table(rows);
}

main().catch((err) => { console.error(err); process.exit(1); });
