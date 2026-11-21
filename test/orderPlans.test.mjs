import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderList, idxTick, roundIdx } from '../src/engine/orderPlans.js';
import { idxEngineCfg } from '../src/markets/idx.js';
import { resolveEngineCfg } from '../src/engine/config.js';

test('IDX tick table and rounding', () => {
  assert.equal(idxTick(150), 1); assert.equal(idxTick(450), 2); assert.equal(idxTick(1500), 5); assert.equal(idxTick(4500), 10); assert.equal(idxTick(9150), 25);
  assert.equal(roundIdx(9151, 'up'), 9175); assert.equal(roundIdx(9174, 'down'), 9150); assert.equal(roundIdx(1503, 'up'), 1505);
});

test('IDX order list: buy now, prepare, sell plan, sized in lots at 2% risk', () => {
  const cfg = idxEngineCfg({ riskPerTradePct: 2, tradeAllocationPct: 0.3, idx: {} });
  const plans = {
    'BBCA.JK': { profile: 'idxBreakout', level: 9000, stop: 8400, target: 10200, distancePct: -0.5, odds: { pTarget: 0.41, pStop: 0.3 } },
    'TLKM.JK': { profile: 'idxBreakout', level: 3000, stop: 2800, target: 3400, distancePct: 4 },
    'ASII.JK': { profile: 'idxBreakout', level: 5000, stop: 4700, target: 5600, distancePct: 20 }
  };
  const prices = { 'BBCA.JK': 9040, 'TLKM.JK': 2885, 'ASII.JK': 4160, 'BBRI.JK': 4100 };
  const positions = { 'BBRI.JK': { symbol: 'BBRI.JK', profile: 'idxBreakout', entryPrice: 4000, stopPrice: 3700, initialStop: 3700, quantity: 1200, openedAt: '2026-11-10T09:00:00Z' } };
  const o = buildOrderList({ market: 'idx', plans, prices, positions, cfg, equityIdr: 20_000_000, cashIdr: 10_000_000 });
  assert.equal(o.buyNow.length, 1);
  const b = o.buyNow[0];
  assert.equal(b.symbol, 'BBCA.JK');
  assert.equal(b.entry, 9050); // 9040 rounded up to the 25 tick
  assert.equal(b.stop % 25, 0);
  assert.ok(b.lots >= 1 && b.riskIdr <= 400_000);
  assert.ok(b.valueIdr <= 6_000_000); // 30% allocation cap
  assert.deepEqual(o.prepare.map((x) => x.symbol), ['TLKM.JK']);
  assert.equal(o.prepare[0].entry, 3010); // level x 1.001 rounded up to the 10 tick
  assert.equal(o.sell[0].lots, 12);
  assert.equal(o.sell[0].target, 4600); // +2R
  assert.equal(o.sell[0].stop, 3700);
  assert.ok(o.sell[0].sellBy);
});

test('blocked market filter and too-far breakouts are left out; crypto sizes in USDT', () => {
  const cfg = resolveEngineCfg({});
  const plans = { BTCUSDT: { profile: 'breakout55', level: 100000, stop: 94000, distancePct: -10 }, ETHUSDT: { profile: 'breakout55', level: 3000, stop: 2800, distancePct: 2 } };
  const o = buildOrderList({ market: 'crypto', plans, prices: { BTCUSDT: 110000, ETHUSDT: 2940 }, positions: {}, cfg, equityIdr: 20_000_000, cashIdr: 20_000_000, usdIdrRate: 16000 });
  assert.equal(o.buyNow.length, 0); // 10% above the level is more than 0.75 ATR
  assert.equal(o.prepare[0].symbol, 'ETHUSDT');
  assert.ok(o.prepare[0].valueUsdt > 0);
  const none = buildOrderList({ market: 'crypto', plans, prices: { BTCUSDT: 100500, ETHUSDT: 2940 }, positions: {}, cfg, equityIdr: 20_000_000, cashIdr: 20_000_000, usdIdrRate: 16000, allowed: () => false });
  assert.equal(none.buyNow.length + none.prepare.length, 0);
});
