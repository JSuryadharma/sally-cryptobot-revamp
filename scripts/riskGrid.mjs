// Robot replay at 2-5% risk per trade over 1 month, 3 months and 3 years.
//   KLINES_DIR=/var/lib/klines INITIAL_IDR=20000000 node scripts/riskGrid.mjs out.json
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';
import fs from 'node:fs';
const end = Date.parse('2026-11-14');
const D = 86400000;
const series = await loadSeries({ symbols: DEFAULT_SYMBOLS, startMs: end - 1100 * D, endMs: end });
const variants = [
  ['2% (sekarang)', { riskPerTradePct: 2 }],
  ['3% risiko saja', { riskPerTradePct: 3 }],
  ['3% + batas ikut naik', { riskPerTradePct: 3, maxPortfolioRiskPct: 15, tradeAllocationPct: 0.45, dailyLossLimitPct: 6 }],
  ['4% + batas ikut naik', { riskPerTradePct: 4, maxPortfolioRiskPct: 20, tradeAllocationPct: 0.6, dailyLossLimitPct: 8 }],
  ['5% + batas ikut naik', { riskPerTradePct: 5, maxPortfolioRiskPct: 25, tradeAllocationPct: 0.75, dailyLossLimitPct: 10 }]
];
const rows = []; const keep = {};
for (const [wl, days] of [['1m', 30], ['3m', 91], ['3y', 1095]]) {
  for (const [name, o] of variants) {
    const cfg = resolveEngineCfg({ roundTripCostPct: 0.2, slippagePct: 0.05, ...o });
    const r = simulate(series, { symbols: DEFAULT_SYMBOLS, startMs: end - days * D, endMs: end, autopilot: true, cfg });
    const m = r.metrics;
    rows.push({ w: wl, name, ret: m.totalReturnPct, dd: m.maxDrawdownPct, n: m.closedTrades, win: m.winRate, final: Math.round(m.finalEquityIdr) });
    if (wl !== '3y') keep[`${wl}|${name}`] = { eq: r.equityCurve.map((e) => [e.date, Math.round(e.equityIdr)]), tx: r.transactions };
    if (wl === '3y') { // worst 91-day window on the equity curve
      const eq = r.equityCurve; let worst = Infinity;
      for (let i = 0; i < eq.length; i++) { const j = eq.findIndex((e) => Date.parse(e.date) >= Date.parse(eq[i].date) + 91 * D); if (j < 0) break; worst = Math.min(worst, eq[j].equityIdr / eq[i].equityIdr - 1); }
      rows.at(-1).worst3m = Math.round(worst * 1000) / 10;
    }
  }
}
console.table(rows);
fs.writeFileSync(process.argv[2], JSON.stringify({ rows, keep }));
