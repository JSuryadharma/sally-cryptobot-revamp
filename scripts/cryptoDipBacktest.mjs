// Crypto dip buy (strategies/dip.js, profile cryptoDip) next to the live
// robot (autopilot breakouts + gap sleeve + scale-in), Rp 20M, windows ending
// at the given date. Data: KLINES_DIR from scripts/mirrorKlines.mjs.
//   KLINES_DIR=/var/lib/klines INITIAL_IDR=20000000 node scripts/cryptoDipBacktest.mjs 2026-11-21
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';
const end = Date.parse(process.argv[2] || '2026-11-21');
const D = 86_400_000;
const series = await loadSeries({ symbols: DEFAULT_SYMBOLS, startMs: end - 1100 * D, endMs: end });
const base = resolveEngineCfg({});
const variants = (process.env.VARIANTS ? JSON.parse(process.env.VARIANTS) : [
  ['robot only', { dip: false }],
  ['+ climax dip, stop 15%', {}],
  ['+ climax dip, stop 10%', { ov: { dipStopPct: 10 } }],
  ['+ climax dip, stop 25%', { ov: { dipStopPct: 25 } }],
  ['+ RSI2 dip (IDX rule)', { ov: { climaxVolMult: null, trendSmaBars: 200, rsiBars: 2, rsiMax: 10, firstUpExit: false, smaExitBars: 5, dipStopPct: 15 } }]
]);
const rows = [];
for (const [name, v] of variants) {
  for (const [w, days] of (process.env.WINDOWS ? JSON.parse(process.env.WINDOWS) : [['3m', 91], ['6m', 182], ['1y', 365], ['3y', 1065]])) {
    const cfg = resolveEngineCfg({ ...base, profiles: { ...base.profiles, cryptoDip: v.dip !== false }, profileOverrides: { cryptoDip: v.ov || {} } });
    const { metrics: m, transactions } = simulate(series, { symbols: DEFAULT_SYMBOLS, startMs: end - days * D, endMs: end, autopilot: true, cfg });
    const dips = (transactions || []).filter((t) => t.type === 'SELL' && !t.partial && t.profile === 'cryptoDip');
    rows.push({ name, w, ret: m.totalReturnPct, dd: m.maxDrawdownPct, trades: m.closedTrades, win: m.winRate, dipTrades: dips.length, dipWin: dips.length ? Math.round(100 * dips.filter((t) => t.tradeRealizedIdr > 0).length / dips.length) : null });
  }
}
console.table(rows);
console.log(JSON.stringify(rows));
