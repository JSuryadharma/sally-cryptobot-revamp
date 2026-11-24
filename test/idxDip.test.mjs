import test from 'node:test';
import assert from 'node:assert/strict';
import { idxEngineCfg } from '../src/markets/idx.js';
import { bookView } from '../src/account.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { profilesFor, resolveEngineCfg } from '../src/engine/config.js';
import { enrichCandles } from '../src/indicators.js';
import { rsiAt, dipCheck } from '../src/engine/strategies/dip.js';

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000;
function candles(closes) {
  return enrichCandles(closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    const time = T0 + i * DAY;
    return { time, date: new Date(time * 1000).toISOString().slice(0, 10), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 20_000_000, closeTime: (time + DAY) * 1000 };
  }));
}
// 230 days rising 0.3%/day, then two -4% days, then a bounce.
const rising = Array.from({ length: 230 }, (_, i) => 5000 * 1.003 ** i);
const last = rising.at(-1);
const stockCloses = [...rising, last * 0.96, last * 0.96 * 0.96, last * 0.96 * 0.96 * 1.01, last * 0.96 * 0.96 * 1.06, last * 1.0];
// IHSG falling: the breakout's market filter blocks, the dip buy ignores it.
const ihsgCloses = stockCloses.map((_, i) => 8000 * 0.998 ** i);

test('RSI(2) drops under 10 after two sharp red days in an uptrend', () => {
  const bars = candles(stockCloses);
  const profile = profilesFor(idxEngineCfg({})).idxDip;
  assert.ok(rsiAt(bars, 229) > 90);
  const chk = dipCheck(bars, 231, profile);
  assert.equal(chk.uptrend, true);
  assert.ok(chk.rsi < 10, `rsi ${chk.rsi}`);
  assert.equal(chk.ok, true);
});

test('dip buy trades while IHSG is below its 50-day average and sells on the bounce', () => {
  const series = { BBCA: { '1d': candles(stockCloses) }, IHSG: { '1d': candles(ihsgCloses) } };
  const cfg = idxEngineCfg({ riskPerTradePct: 2, maxPortfolioRiskPct: 8, dailyLossLimitPct: 5, maxConsecutiveLosses: 5, drawdownHaltPct: 20, tradeAllocationPct: 0.3, idx: { maxOpenPositions: 4 } });
  const account = createPortfolio(100_000_000);
  const book = bookView(account, 'idx');
  const endMs = series.BBCA['1d'].at(-1).closeTime + 1;
  const out = advance(createEngineState(), book, series, { nowMs: endMs, startMs: series.BBCA['1d'][220].closeTime, usdIdrRate: 1, cfg, tradeSymbols: ['BBCA'], keepAllTransactions: true });
  const buys = out.transactions.filter((t) => t.type === 'BUY');
  const sells = out.transactions.filter((t) => t.type === 'SELL');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].profile, 'idxDip');
  assert.equal(buys[0].quantity % 100, 0);
  assert.equal(sells.length, 1);
  assert.match(sells[0].reason, /Bounce exit/);
  assert.ok(sells[0].price > buys[0].price);
});

test('the dip buy is on for IDX and off for crypto', () => {
  assert.equal(idxEngineCfg({}).profiles.idxDip, true);
  assert.ok(!resolveEngineCfg({}).profiles?.idxDip);
});

test('crypto dip: close under the lower band on 2x volume buys, the first higher close sells', async () => {
  const { climaxAt } = await import('../src/engine/strategies/dip.js');
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 0.5);
  closes.push(90, 91);
  const bars = candles(closes).map((b, i) => ({ ...b, volume: i === 40 ? 60_000_000 : 20_000_000 }));
  const cl = climaxAt(bars, 40, 2);
  assert.equal(cl.below, true);
  assert.equal(cl.volX, 3);
  assert.equal(cl.ok, true);
  assert.equal(climaxAt(bars.map((b) => ({ ...b, volume: 20_000_000 })), 40, 2).ok, false);
});
