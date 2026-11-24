// IDX dip buy (strategies/dip.js) through the live engine loop, next to the
// 55-day breakout. Data: IDX_DATA_DIR with <SYMBOL>.json daily candles
// (time = close ms / 1000 - 86400, closeTime) incl. IHSG.json, e.g. built from
// github.com/Faridfarid/idx-market-data (adj_close; see
// docs/research/regime-50d-2026-11-23.md).
//
//   IDX_DATA_DIR=/path/to/json node scripts/idxDipBacktest.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
const R = new URL('../src', import.meta.url).href;
const { advance, createEngineState } = await import(`${R}/engine/core.js`);
const { createPortfolio } = await import(`${R}/engine/ledger.js`);
const { bookView } = await import(`${R}/account.js`);
const { idxEngineCfg, IDX_REGIME_SYMBOL } = await import(`${R}/markets/idx.js`);
const { enrichCandles } = await import(`${R}/indicators.js`);
const { DEFAULT_ENGINE_CFG } = await import(`${R}/engine/config.js`);
const DIR = process.env.IDX_DATA_DIR;
const symbols = (await fs.readdir(DIR)).map((f) => f.replace('.json', '')).filter((s) => s !== IDX_REGIME_SYMBOL);
const series = {};
for (const s of [...symbols, IDX_REGIME_SYMBOL]) series[s] = { '1d': enrichCandles(JSON.parse(await fs.readFile(path.join(DIR, `${s}.json`), 'utf8'))) };
const endMs = series[IDX_REGIME_SYMBOL]['1d'].at(-1).closeTime + 1;
const START = 100_000_000;
const settings = { riskPerTradePct: DEFAULT_ENGINE_CFG.riskPerTradePct, maxPortfolioRiskPct: DEFAULT_ENGINE_CFG.maxPortfolioRiskPct, dailyLossLimitPct: DEFAULT_ENGINE_CFG.dailyLossLimitPct, maxConsecutiveLosses: DEFAULT_ENGINE_CFG.maxConsecutiveLosses, drawdownHaltPct: DEFAULT_ENGINE_CFG.drawdownHaltPct, tradeAllocationPct: DEFAULT_ENGINE_CFG.tradeAllocationPct, idx: { maxOpenPositions: 4 } };
function run({ breakout = true, dip = true, dipOv = {} }, fromMs) {
  const base = idxEngineCfg(settings);
  const cfg = { ...base, profiles: { ...base.profiles, idxBreakout: breakout, idxDip: dip }, profileOverrides: { idxDip: dipOv } };
  const account = createPortfolio(START); const book = bookView(account, 'idx');
  let peak = START, dd = 0;
  const out = advance(createEngineState(), book, series, { nowMs: endMs, startMs: fromMs, usdIdrRate: 1, cfg, tradeSymbols: symbols, keepAllTransactions: true,
    onGroup: (_, pf) => { const eq = pf.balanceIdr + Object.values(pf.positions).reduce((s, x) => s + x.investedIdr, 0); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); } });
  const closed = out.transactions.filter((t) => t.type === 'SELL' && !t.partial);
  const by = {};
  for (const t of closed) { const k = t.profile; (by[k] ||= { n: 0, w: 0 }); by[k].n += 1; if (t.tradeRealizedIdr > 0) by[k].w += 1; }
  const equity = account.balanceIdr + Object.values(book.positions).reduce((s, x) => s + x.investedIdr, 0);
  const skips = {};
  for (const s of out.signals.filter((x) => !x.taken && x.profile === 'idxDip')) { const k = String(s.skip).split(':')[0].slice(0, 30); skips[k] = (skips[k] || 0) + 1; }
  return { ret: Math.round((equity / START - 1) * 1000) / 10, dd: Math.round(dd * 1000) / 10, ...Object.fromEntries(Object.entries(by).map(([k, v]) => [k, `${v.n} / ${Math.round(100 * v.w / v.n)}%`])), skips: JSON.stringify(skips).slice(0, 120) };
}
const variants = [['breakout only', { dip: false }], ['dip only', { breakout: false }], ['both, stop 10% (live)', {}], ['both, stop 15%', { dipOv: { dipStopPct: 15 } }], ['both, stop 25%', { dipOv: { dipStopPct: 25 } }]];
const rows = [];
for (const [name, v] of variants) for (const [w, days] of [['15y', 15 * 365], ['5y', 1826], ['2y', 730], ['1y', 365], ['6m', 182]]) rows.push({ name, w, ...run(v, endMs - days * 864e5) });
console.table(rows);
