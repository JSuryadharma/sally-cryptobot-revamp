// Live robot replay over the last 1 and 3 months for a chart page.
//   KLINES_DIR=/var/lib/klines INITIAL_IDR=20000000 node scripts/robotWindowSim.mjs 2026-11-14 out.json
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';
import fs from 'node:fs';
const end = Date.parse(process.argv[2]);
const out = {};
const series = await loadSeries({ symbols: DEFAULT_SYMBOLS, startMs: end - 92 * 86400000, endMs: end });
for (const [label, days] of [['1m', 30], ['3m', 91]]) {
  const startMs = end - days * 86400000;
  const cfg = resolveEngineCfg({ roundTripCostPct: 0.2, slippagePct: 0.05 });
  const r = simulate(series, { symbols: DEFAULT_SYMBOLS, startMs, endMs: end, autopilot: true, cfg });
  out[label] = { startMs, endMs: end, metrics: r.metrics, transactions: r.transactions, equityCurve: r.equityCurve };
}
const used = new Set(Object.values(out).flatMap((o) => o.transactions.map((t) => t.symbol)));
used.add('BTCUSDT');
out.candles = {};
for (const s of used) out.candles[s] = series[s]['1d'].filter((b) => b.time * 1000 >= end - 95 * 86400000).map((b) => [b.time, b.open, b.high, b.low, b.close]);
out.candles4h = {};
for (const s of used) out.candles4h[s] = series[s]['4h'].filter((b) => b.time * 1000 >= end - 95 * 86400000).map((b) => [b.time, b.open, b.high, b.low, b.close]);
fs.writeFileSync(process.argv[3], JSON.stringify(out));
for (const l of ['1m', '3m']) { const m = out[l].metrics; console.log(l, m.totalReturnPct, m.maxDrawdownPct, m.closedTrades, m.winRate, m.finalEquityIdr, JSON.stringify(m.openAtEnd)); }
console.log(JSON.stringify(out['3m'].transactions[0]));
