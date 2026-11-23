// Real engine (advance() + autopilot + skill gate, live-price entry) with the
// breakout market filter swapped (cfg.regimeMode), Rp 20M, windows ending --end.
//   KLINES_DIR=/var/lib/klines INITIAL_IDR=20000000 node scripts/regimeEngineBacktest.mjs 2026-11-14
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';
const end = Date.parse(process.argv[2] || '2026-11-14');
const D = 86_400_000;
const series = await loadSeries({ symbols: DEFAULT_SYMBOLS, startMs: end - 1100 * D, endMs: end });
const rows = [];
const DAYS = (process.env.REGIME_DAYS || '200,50').split(',').map(Number);
const MODES = (process.env.REGIME_MODES || 'btc200,coin200,either,off').split(',');
for (const regimeDays of DAYS) for (const mode of MODES) {
  for (const [w, days] of [['1m', 30], ['3m', 91], ['6m', 182], ['1y', 365], ['3y', 1095]]) {
    const cfg = resolveEngineCfg({ roundTripCostPct: 0.2, slippagePct: 0.05, regimeMode: mode, regimeDays });
    const { metrics: m } = simulate(series, { symbols: DEFAULT_SYMBOLS, startMs: end - days * D, endMs: end, autopilot: true, cfg });
    rows.push({ days: regimeDays, mode, w, ret: m.totalReturnPct, dd: m.maxDrawdownPct, n: m.closedTrades, win: m.winRate, pf: m.profitFactor });
  }
}
console.table(rows);
console.log(JSON.stringify(rows));
