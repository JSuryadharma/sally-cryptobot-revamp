// IDX breakout backtest on Yahoo Finance daily history, through the same
// engine loop the live robot uses (core.js advance) with the IDX config.
// Needs a machine that can reach query1.finance.yahoo.com.
//
//   node scripts/idxBacktest.mjs            # 5 years, default watchlist
//   node scripts/idxBacktest.mjs --years 3 --symbols BBCA,BBRI,TLKM
import fs from 'node:fs/promises';
import path from 'node:path';
import { advance, createEngineState } from '../src/engine/core.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { bookView } from '../src/account.js';
import { fetchIdxDaily, idxEngineCfg, DEFAULT_IDX_WATCHLIST, IDX_REGIME_SYMBOL } from '../src/markets/idx.js';
import { enrichCandles } from '../src/indicators.js';
import { DEFAULT_ENGINE_CFG } from '../src/engine/config.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const years = Number(arg('years', 5));
const symbols = arg('symbols', DEFAULT_IDX_WATCHLIST.join(',')).split(',').map((s) => s.trim().toUpperCase());
const START_BALANCE = 100_000_000;

const series = {};
for (const symbol of [...symbols, IDX_REGIME_SYMBOL]) {
  try {
    // IDX_DATA_DIR: <SYMBOL>.json daily candles instead of Yahoo (see scripts/skillResearch.mjs).
    const { candles } = process.env.IDX_DATA_DIR
      ? { candles: JSON.parse(await fs.readFile(path.join(process.env.IDX_DATA_DIR, `${symbol}.json`), 'utf8')) }
      : await fetchIdxDaily(symbol, { range: `${years + 1}y` });
    series[symbol] = { '1d': enrichCandles(candles) };
    process.stderr.write(`${symbol} ${candles.length} days\n`);
  } catch (error) {
    process.stderr.write(`${symbol} failed: ${error.message}\n`);
  }
}
const regime = series[IDX_REGIME_SYMBOL]?.['1d'];
if (!regime?.length) throw new Error('No IHSG history: cannot run.');
const endMs = regime.at(-1).closeTime + 1;
const startMs = endMs - years * 365 * 86_400_000;
const settings = {
  riskPerTradePct: DEFAULT_ENGINE_CFG.riskPerTradePct, maxPortfolioRiskPct: DEFAULT_ENGINE_CFG.maxPortfolioRiskPct,
  dailyLossLimitPct: DEFAULT_ENGINE_CFG.dailyLossLimitPct, maxConsecutiveLosses: DEFAULT_ENGINE_CFG.maxConsecutiveLosses,
  drawdownHaltPct: DEFAULT_ENGINE_CFG.drawdownHaltPct, tradeAllocationPct: DEFAULT_ENGINE_CFG.tradeAllocationPct, idx: { maxOpenPositions: 4 }
};

function run(profileOverride, { gate = true } = {}) {
  const cfg = { ...idxEngineCfg(settings), profileOverrides: { idxBreakout: profileOverride } };
  if (!gate) cfg.preTrade = null;
  const account = createPortfolio(START_BALANCE);
  const book = bookView(account, 'idx');
  let peak = START_BALANCE;
  let maxDd = 0;
  const out = advance(createEngineState(), book, series, {
    nowMs: endMs, startMs, usdIdrRate: 1, cfg, tradeSymbols: symbols.filter((s) => series[s]), keepAllTransactions: true,
    onGroup: (_, pf) => {
      const eq = pf.balanceIdr + Object.values(pf.positions).reduce((s, p) => s + p.investedIdr, 0);
      peak = Math.max(peak, eq);
      maxDd = Math.max(maxDd, (peak - eq) / peak);
    }
  });
  const closed = out.transactions.filter((t) => t.type === 'SELL' && !t.partial);
  const wins = closed.filter((t) => t.tradeRealizedIdr > 0).length;
  const equity = account.balanceIdr + Object.values(book.positions).reduce((s, p) => s + p.investedIdr, 0);
  const avgR = closed.length ? closed.reduce((s, t) => s + (t.rMultiple || 0), 0) / closed.length : 0;
  return { trades: closed.length, winPct: closed.length ? Math.round((100 * wins) / closed.length) : 0, avgR: Math.round(avgR * 100) / 100, returnPct: Math.round(((equity / START_BALANCE) - 1) * 1000) / 10, maxDdPct: Math.round(maxDd * 1000) / 10 };
}

const rows = [];
for (const breakoutLookback of [20, 55]) {
  for (const stopAtr of [2, 2.5, 3]) {
    for (const targetR of [1, 2, 3]) rows.push({ breakoutLookback, stopAtr, targetR, ...run({ breakoutLookback, stopAtr, targetR }) });
  }
}
console.table(rows);
// Effect of the day-trader-skill pre-trade gate on the live rule and the best grid row.
const gateRows = [];
for (const p of [{ breakoutLookback: 20, stopAtr: 2.5, targetR: 2 }, { breakoutLookback: 55, stopAtr: 3, targetR: 2 }, { breakoutLookback: 55, stopAtr: 3, targetR: 2, minSkillSetups: 2 }, { breakoutLookback: 55, stopAtr: 3, targetR: 3, minSkillSetups: 2 }]) {
  for (const gate of [true, false]) gateRows.push({ ...p, gate: gate ? 'skill gate on' : 'gate off', ...run(p, { gate }) });
}
console.table(gateRows);
console.log(`Live default: 20-day, 2.5 ATR stop, +2R. ${years} years to ${new Date(endMs).toISOString().slice(0, 10)}, ${symbols.length} stocks, 0.4% round-trip cost.`);
