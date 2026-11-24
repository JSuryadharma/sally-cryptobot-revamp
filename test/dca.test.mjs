import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg } from '../src/engine/config.js';
import { createPortfolio, openPositionQty } from '../src/engine/ledger.js';
import { dcaOnExitBar, spikeAt, scaleInPlan, SCALE_IN_AT_STOP } from '../src/engine/dca.js';

const RATE = 16_000;
const cfg = resolveEngineCfg({ preTrade: null, dca: SCALE_IN_AT_STOP });

function setup() {
  const portfolio = createPortfolio(1_000_000_000);
  openPositionQty(portfolio, { symbol: 'TESTUSDT', profile: 'breakout55', setup: 'b', quantity: 100, entryPrice: 100, stopPrice: 91, riskIdr: 100 * 9.2 * RATE, timeMs: 0, barTime: 0, usdIdrRate: RATE, roundTripCostPct: cfg.roundTripCostPct });
  const ctx = { portfolio, cfg, usdIdrRate: RATE, series: {}, out: { transactions: [] }, keepAll: true, timeFor: () => 1 };
  return { portfolio, ctx };
}

test('scale-in buys half the first lot at the stop and moves the stop to the 1.5R cap', () => {
  const { portfolio, ctx } = setup();
  const pos = portfolio.positions.TESTUSDT;
  const bar = { time: 1, open: 92, high: 92, low: 90.8, close: 91 };
  const added = dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 50 }, pos, bar, 3, 'stop');
  assert.equal(added, true);
  assert.equal(pos.quantity, 150);
  assert.ok(pos.stopPrice < 91 && pos.stopPrice > 86, `stop ${pos.stopPrice}`);
  // Selling everything at the new stop loses about 1.5x the original risk.
  const k = RATE * (1 - cfg.roundTripCostPct / 200) * (1 - cfg.slippagePct / 100);
  const loss = pos.investedIdr - pos.quantity * pos.stopPrice * k;
  assert.ok(Math.abs(loss / pos.riskIdr - 1.5) < 0.01, `loss ${loss / pos.riskIdr}R`);
  assert.equal(ctx.out.transactions[0].dca, true);
  // Only one add.
  assert.equal(dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 80 }, pos, bar, 3, 'stop'), false);
});

test('pre mode needs a spike with volume', () => {
  const { portfolio, ctx } = setup();
  ctx.cfg = resolveEngineCfg({ preTrade: null, dca: { mode: 'pre', rangeMult: 3, volMult: 3 } });
  const quiet = Array.from({ length: 30 }, (_, i) => ({ time: i * 300, open: 95, high: 95.2, low: 94.8, close: 95, volume: 100 }));
  const ref = [{ time: -7200, open: 95, high: 96, low: 94, close: 95, atr14: 1, volumeSma20: 1200 }];
  ctx.series = { TESTUSDT: { '5m': quiet, '1h': ref } };
  const pos = portfolio.positions.TESTUSDT;
  assert.equal(spikeAt(ctx.series, 'TESTUSDT', '5m', 29, { ...ctx.cfg.dca, refTf: '1h', windowBars: 12, red: true, rangeMult: 3, volMult: 3 }).ok, false);
  assert.equal(dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 29 }, pos, quiet[29], 3, 'after'), false);
  const crash = quiet.map((b, i) => (i >= 18 ? { ...b, open: 95 - (i - 18) * 0.4, close: 94.6 - (i - 18) * 0.4, low: 94.4 - (i - 18) * 0.4, volume: 900 } : b));
  ctx.series.TESTUSDT['5m'] = crash;
  assert.equal(dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 29 }, pos, crash[29], 3, 'after'), true);
  assert.equal(pos.quantity, 200);
});

test('no DCA when cfg.dca is off', () => {
  const { portfolio, ctx } = setup();
  ctx.cfg = resolveEngineCfg({ preTrade: null, dca: null });
  const pos = portfolio.positions.TESTUSDT;
  assert.equal(dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 50 }, pos, { time: 1, open: 92, high: 92, low: 90, close: 91 }, 3, 'stop'), false);
});

test('scale-in at the stop is the engine default', () => {
  assert.deepEqual(resolveEngineCfg({}).dca, SCALE_IN_AT_STOP);
});

test('scaleInPlan shows the buy-more level and the stop the add will set', () => {
  const { portfolio, ctx } = setup();
  const pos = portfolio.positions.TESTUSDT;
  const plan = scaleInPlan(pos, cfg, RATE);
  assert.equal(plan.triggered, false);
  assert.equal(plan.price, pos.stopPrice);
  assert.equal(plan.addQuantity, 50);
  assert.ok(plan.addSpendIdr > 0);
  // The add at exactly the stop sets the same stop as predicted.
  const bar = { time: 1, open: 92, high: 92, low: 90.8, close: pos.stopPrice };
  assert.equal(dcaOnExitBar(ctx, { symbol: 'TESTUSDT', tf: '5m', i: 50 }, pos, bar, 3, 'stop'), true);
  assert.ok(Math.abs(plan.newStop - pos.stopPrice) < 1e-6, `${plan.newStop} vs ${pos.stopPrice}`);
  const done = scaleInPlan(pos, cfg, RATE);
  assert.equal(done.triggered, true);
  assert.equal(done.newStop, pos.stopPrice);
  // Off when dca is off.
  assert.equal(scaleInPlan(pos, resolveEngineCfg({ preTrade: null, dca: null }), RATE), null);
});
