// Averaging down on capitulation spikes (engine/dca.js) vs the live stop rule,
// through the real engine (autopilot, skill gate, gap sleeve) on one account.
//
//   KLINES_DIR=... node scripts/dcaBacktest.mjs --months 36 --end 2026-11-21
//   ONLY=replace node scripts/dcaBacktest.mjs   (variants whose name contains it)
import fs from 'node:fs/promises';
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate, DEFAULT_SYMBOLS } from './backtest.mjs';
import { SCALE_IN_AT_STOP } from '../src/engine/dca.js';

const MONTH_MS = 30 * 86_400_000;

// name -> cfg.dca (null = live rule). Defaults in engine/dca.js DCA_DEFAULTS.
export const VARIANTS = {
  'live: 3-ATR stop, no DCA': null,
  'SHIPPED scale-in at stop (Settings switch)': SCALE_IN_AT_STOP,
  // Add before the stop: trade >= 0.5R under water + 1h spike.
  'pre 1h 3xATR 3xVol, +1x, cap 2R': { mode: 'pre' },
  'pre 1h 2xATR 2xVol, +1x, cap 2R': { mode: 'pre', rangeMult: 2, volMult: 2 },
  'pre 1h 4xATR 5xVol, +1x, cap 2R': { mode: 'pre', rangeMult: 4, volMult: 5 },
  'pre 1h 3xATR 3xVol, +0.5x, cap 1.5R': { mode: 'pre', addFrac: 0.5, capR: 1.5 },
  'pre 1h 3xATR 3xVol, +1x, cap 3R': { mode: 'pre', capR: 3 },
  'pre 1h 3xATR 3xVol, +1x x2, cap 3R': { mode: 'pre', maxAdds: 2, capR: 3 },
  'pre 1h 3xATR 3xVol, +1x, cap 2R, tgt avg+1R': { mode: 'pre', target: 'avg', targetR: 1 },
  'pre 4h 2xATR 2xVol, +1x, cap 2R': { mode: 'pre', refTf: '4h', windowBars: 48, rangeMult: 2, volMult: 2 },
  'pre 1h 3xATR 3xVol, arm 0R, +1x, cap 2R': { mode: 'pre', armR: 0 },
  // Instead of the stop: only when the stop candle comes with a spike.
  'replace 1h 3xATR 3xVol, +1x, cap 2R': { mode: 'replace' },
  'replace 1h 2xATR 2xVol, +1x, cap 2R': { mode: 'replace', rangeMult: 2, volMult: 2 },
  'replace 1h 3xATR 3xVol, +0.5x, cap 2R': { mode: 'replace', addFrac: 0.5 },
  'replace 1h 3xATR 3xVol, +1x, cap 3R': { mode: 'replace', capR: 3 },
  'replace 1h 2xATR 2xVol, +1x, cap 3R, tgt avg+1R': { mode: 'replace', rangeMult: 2, volMult: 2, capR: 3, target: 'avg', targetR: 1 },
  'replace 4h 2xATR 2xVol, +1x, cap 3R': { mode: 'replace', refTf: '4h', windowBars: 48, rangeMult: 2, volMult: 2, capR: 3 },
  // Any spike at the stop (no volume condition): is volume what matters?
  'replace 1h 2xATR any vol, +1x, cap 3R': { mode: 'replace', rangeMult: 2, volMult: 0, capR: 3 },
  // Controls: the same adds with no spike condition at all, and plain bigger risk.
  'CONTROL pre any dip 0.5R, +1x, cap 2R': { mode: 'pre', rangeMult: 0, volMult: 0, red: false },
  'CONTROL pre any dip 0R, +1x, cap 2R': { mode: 'pre', armR: 0, rangeMult: 0, volMult: 0, red: false },
  'CONTROL pre any dip 0.5R, +1x x2, cap 3R': { mode: 'pre', rangeMult: 0, volMult: 0, red: false, maxAdds: 2, capR: 3 },
  'CONTROL replace always, +1x, cap 2R': { mode: 'replace', rangeMult: 0, volMult: 0, red: false },
  'CONTROL replace always, +1x, cap 3R': { mode: 'replace', rangeMult: 0, volMult: 0, red: false, capR: 3 },
  'CONTROL pre any dip 0.5R, +0.5x, cap 1.5R': { mode: 'pre', rangeMult: 0, volMult: 0, red: false, addFrac: 0.5, capR: 1.5 },
  'CONTROL replace always, +0.5x, cap 2R': { mode: 'replace', rangeMult: 0, volMult: 0, red: false, addFrac: 0.5 },
  'ROBUST replace 1h 2.5xATR 2.5xVol, +1x, cap 2R': { mode: 'replace', rangeMult: 2.5, volMult: 2.5 },
  'ROBUST replace 1h 1.5xATR 1.5xVol, +1x, cap 2R': { mode: 'replace', rangeMult: 1.5, volMult: 1.5 },
  'ROBUST replace 1h 2xATR 3xVol, +1x, cap 2R': { mode: 'replace', rangeMult: 2, volMult: 3 },
  'ROBUST replace 1h 3xATR 2xVol, +1x, cap 2R': { mode: 'replace', rangeMult: 3, volMult: 2 },
  'WIDE no DCA, 4-ATR stop, same target price': { extra: { profileOverrides: { breakout55: { stopAtr: 4, targetR: 2.25 }, breakout: { stopAtr: 4, targetR: 0.75 } } } },
  'WIDE no DCA, 5-ATR stop, same target price': { extra: { profileOverrides: { breakout55: { stopAtr: 5, targetR: 1.8 }, breakout: { stopAtr: 5, targetR: 0.6 } } } },
  'WIDE no DCA, 5-ATR stop, +3R': { extra: { profileOverrides: { breakout55: { stopAtr: 5 }, breakout: { stopAtr: 5 } } } },
  'CONTROL replace always, +0.5x, cap 1.5R': { mode: 'replace', rangeMult: 0, volMult: 0, red: false, addFrac: 0.5, capR: 1.5 },
  'CONTROL no DCA, 3% risk': { extra: { riskPerTradePct: 3 } },
  'CONTROL no DCA, 4% risk': { extra: { riskPerTradePct: 4 } },
  'NOISE no DCA, slippage 0.06%': { extra: { slippagePct: 0.06 } },
  'NOISE no DCA, cost 0.21%': { extra: { roundTripCostPct: 0.21 } }
};

function parseArgs(argv) {
  const args = { months: 36, symbols: DEFAULT_SYMBOLS, end: Date.parse('2026-11-21'), cost: 0.2, slip: 0.05, split: Date.parse('2025-09-10'), out: null };
  for (let k = 0; k < argv.length; k += 1) {
    const [flag, value] = [argv[k], argv[k + 1]];
    if (flag === '--months') { args.months = Number(value); k += 1; }
    else if (flag === '--end') { args.end = Date.parse(value); k += 1; }
    else if (flag === '--split') { args.split = Date.parse(value); k += 1; }
    else if (flag === '--cost') { args.cost = Number(value); k += 1; }
    else if (flag === '--out') { args.out = value; k += 1; }
  }
  return args;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// Tail numbers from the trades and the daily equity curve.
function tail(sim) {
  const txs = [...sim.transactions].reverse();
  const buys = new Map();
  const adds = new Map();
  for (const t of txs) {
    if (t.type !== 'BUY') continue;
    if (t.dca) adds.set(t.tradeId, (adds.get(t.tradeId) || 0) + 1);
    else buys.set(t.tradeId, t);
  }
  const finals = txs.filter((t) => t.type === 'SELL' && !t.partial);
  const rs = finals.map((t) => t.rMultiple).filter(Number.isFinite).sort((a, b) => a - b);
  const worst = finals.reduce((w, t) => (!w || t.tradeRealizedIdr < w.tradeRealizedIdr ? t : w), null);
  const k = Math.max(1, Math.round(rs.length * 0.05));
  const cvar5 = rs.length ? rs.slice(0, k).reduce((s, v) => s + v, 0) / k : null;
  const dcaTrades = finals.filter((t) => adds.has(t.tradeId));
  const dcaR = dcaTrades.map((t) => t.rMultiple).filter(Number.isFinite);
  let worstDay = 0;
  const eq = sim.equityCurve;
  for (let i = 1; i < eq.length; i += 1) worstDay = Math.min(worstDay, (eq[i].equityIdr / eq[i - 1].equityIdr - 1) * 100);
  return {
    worstR: rs[0] ?? null,
    worstTrade: worst ? `${worst.symbol} ${worst.createdAt.slice(0, 10)} ${r2(worst.rMultiple)}R` : null,
    worstTradePctEq: worst ? r2((worst.tradeRealizedIdr / 10_000_000) * 100) : null,
    cvar5R: r2(cvar5),
    le15R: rs.filter((v) => v <= -1.5).length,
    worstDayPct: r2(worstDay),
    dcaAdds: [...adds.values()].reduce((s, v) => s + v, 0),
    dcaTrades: dcaTrades.length,
    dcaWins: dcaTrades.filter((t) => t.tradeRealizedIdr > 0).length,
    dcaAvgR: dcaR.length ? r2(dcaR.reduce((s, v) => s + v, 0) / dcaR.length) : null,
    dcaSumR: r2(dcaR.reduce((s, v) => s + v, 0))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Loading ${args.symbols.length} coins, ${day(startMs)} -> ${day(args.end)}...`);
  const series = await loadSeries({ symbols: args.symbols, startMs, endMs: args.end, log: () => {} });
  const base = { roundTripCostPct: args.cost, slippagePct: args.slip };
  const rows = [];
  const trades = {};
  const windows = [['all', startMs, args.end], ['train', startMs, args.split], ['test', args.split, args.end]];
  for (const [name, dca] of Object.entries(VARIANTS).filter(([n]) => n.startsWith('live') || !process.env.ONLY || process.env.ONLY.split('|').some((o) => n.includes(o)))) {
    for (const [label, from, to] of windows) {
      const t0 = Date.now();
      const cfg = dca?.extra ? resolveEngineCfg({ ...base, ...dca.extra, dca: null }) : resolveEngineCfg({ ...base, dca });
      const sim = simulate(series, { symbols: args.symbols, startMs: from, endMs: to, autopilot: true, cfg });
      const m = sim.metrics;
      const row = { run: name, window: label, returnPct: m.totalReturnPct, maxDdPct: m.maxDrawdownPct, trades: m.closedTrades, winPct: m.winRate, avgR: m.expectancyR, pf: m.profitFactor, ...tail(sim), secs: Math.round((Date.now() - t0) / 1000) };
      rows.push(row);
      if (label === 'all') {
        trades[name] = [...sim.transactions].reverse().filter((t) => t.type === 'BUY' || (t.type === 'SELL' && !t.partial))
          .map((t) => ({ at: t.createdAt, type: t.dca ? 'ADD' : t.type, symbol: t.symbol, profile: t.profile, price: t.price, r: t.rMultiple ?? null, exit: t.exitKind ?? null, tradeId: t.tradeId, reason: t.dca ? t.reason : undefined }));
      }
      console.log(JSON.stringify(row));
    }
  }
  console.table(rows.map(({ worstTrade, ...r }) => r));
  if (args.out) await fs.writeFile(args.out, JSON.stringify({ args: { ...args, start: day(startMs), end: day(args.end), split: day(args.split) }, rows, trades }, null, 1));
}

main().catch((err) => { console.error(err); process.exit(1); });
