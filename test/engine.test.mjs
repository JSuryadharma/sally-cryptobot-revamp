import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, PROFILES, TF_MS } from '../src/engine/config.js';
import { sizePosition, bookEquityIdr } from '../src/engine/sizing.js';
import { onBar, onExitBar } from '../src/engine/positionManager.js';
import { createPortfolio, openPositionQty, sellPosition } from '../src/engine/ledger.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { updateRisk, recordTradeResult, createRiskState, entryBlock } from '../src/engine/riskGuard.js';
import { syntheticSeries, cutSeries } from './helpers.mjs';

const RATE = 16_000;
const cfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0 });
const scalp = PROFILES.scalping;

function position(overrides = {}) {
  return {
    symbol: 'TESTUSDT', profile: 'scalping', quantity: 10, entryPrice: 100, stopPrice: 98, initialStop: 98,
    highWaterMark: 100, barsHeld: 0, partialTaken: false, mfeR: 0, investedIdr: 100 * 10 * RATE, ...overrides
  };
}

const bar = (o) => ({ time: 0, open: 100, high: 100.5, low: 99.5, close: 100.2, atr14: 1, ema50: 95, ...o });

test('sizing risks riskPerTradePct of equity, costs included', () => {
  const pf = createPortfolio(10_000_000);
  const { qty, riskIdr } = sizePosition({ portfolio: pf, entryPrice: 1, stopPrice: 0.98, usdIdrRate: RATE, cfg: { ...cfg, tradeAllocationPct: 1 } });
  assert.ok(Math.abs(riskIdr - 75_000) < 1, `risk ${riskIdr}`);
  assert.ok(Math.abs(qty * (0.02 + 0.002) * RATE - 75_000) < 1);
});

test('sizing caps notional at tradeAllocationPct of equity', () => {
  const pf = createPortfolio(10_000_000);
  const { qty } = sizePosition({ portfolio: pf, entryPrice: 1, stopPrice: 0.999, usdIdrRate: RATE, cfg });
  assert.ok(qty * 1 * RATE * 1.001 <= 3_000_000 + 1);
});

test('sizing refuses when portfolio open risk is used up', () => {
  const pf = createPortfolio(10_000_000);
  pf.positions.A = { entryPrice: 1, stopPrice: 0.9, quantity: 300_000 / (0.1 * RATE) * 1.0, investedIdr: 0 };
  const result = sizePosition({ portfolio: pf, entryPrice: 1, stopPrice: 0.98, usdIdrRate: RATE, cfg });
  assert.equal(result.qty, 0);
});

test('onBar: gap below stop fills at the open', () => {
  const { fills } = onBar(position(), bar({ open: 97, high: 97.5, low: 96, close: 97 }), scalp, cfg);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].exitKind, 'stop');
  assert.ok(Math.abs(fills[0].price - 97 * (1 - cfg.slippagePct / 100)) < 1e-9);
});

test('onBar: stop touch fills at the stop minus slippage', () => {
  const { fills } = onBar(position(), bar({ low: 97.9 }), scalp, cfg);
  assert.equal(fills[0].exitKind, 'stop');
  assert.ok(Math.abs(fills[0].price - 98 * (1 - cfg.slippagePct / 100)) < 1e-9);
});

test('onBar: a bar touching both stop and 1R counts as a stop', () => {
  const { fills } = onBar(position(), bar({ low: 97.5, high: 103 }), scalp, cfg);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].exitKind, 'stop');
});

test('onBar: with a partial configured, 1R sells part and moves the stop to breakeven plus costs', () => {
  const partialCfg = { ...cfg, partialFraction: 0.5 };
  const { fills, updates } = onBar(position(), bar({ high: 102.1, close: 101.5 }), scalp, partialCfg);
  assert.equal(fills[0].exitKind, 'partial');
  assert.equal(fills[0].price, 102);
  assert.equal(updates.partialTaken, true);
  assert.ok(updates.stopPrice >= 100 * (1 + cfg.roundTripCostPct / 100) - 1e-9);
});

test('onBar: default (no partial) still arms breakeven at 1R without selling', () => {
  const { fills, updates } = onBar(position(), bar({ high: 102.1, close: 101.5 }), scalp, cfg);
  assert.equal(fills.length, 0);
  assert.equal(updates.partialTaken, true);
  assert.ok(updates.stopPrice >= 100 * (1 + cfg.roundTripCostPct / 100) - 1e-9);
});

test('onBar: fixed target exits the whole position', () => {
  const { fills } = onBar(position(), bar({ high: 104.5 }), scalp, { ...cfg, targetR: 2 });
  assert.equal(fills.at(-1).exitKind, 'target');
  assert.equal(fills.at(-1).price, 104);
});

test('onBar: trailing stop never moves down', () => {
  const p = position({ partialTaken: true, stopPrice: 101, highWaterMark: 104 });
  const { updates } = onBar(p, bar({ open: 102, high: 103, low: 101.5, close: 102, atr14: 2 }), scalp, cfg);
  assert.equal(updates.stopPrice, 101);
});

test('onExitBar: a 5m candle hits the target without waiting for the trigger close', () => {
  const { fills } = onExitBar(position(), bar({ high: 103.1 }), scalp, { ...cfg, targetR: 1.5 }, 1);
  assert.equal(fills.at(-1).exitKind, 'target');
  assert.equal(fills.at(-1).price, 103);
});

test('onExitBar: reaching 1R moves the stop to breakeven for the next candle, not this one', () => {
  const { fills, updates } = onExitBar(position(), bar({ high: 102.1, low: 99 }), scalp, cfg, 1);
  assert.equal(fills.length, 0);
  assert.ok(updates.stopPrice >= 100 * (1 + cfg.roundTripCostPct / 100) - 1e-9);
  const next = onExitBar({ ...position(), ...updates }, bar({ open: 100.5, low: 100.1 }), scalp, cfg, 1);
  assert.equal(next.fills[0].exitKind, 'stop');
  assert.equal(next.updates, null);
});

test('onExitBar: leaves bars held and the time stop to the trigger close', () => {
  const { fills, updates } = onExitBar(position({ barsHeld: 999 }), bar({}), scalp, cfg, 1);
  assert.equal(fills.length, 0);
  assert.equal(updates.barsHeld, undefined);
});

test('onBar without price exits: counts the bar and runs the time stop but ignores the range', () => {
  const p = position({ barsHeld: 15, mfeR: 0.2 });
  const { fills, updates } = onBar(p, bar({ low: 90, high: 120 }), scalp, cfg, { priceExits: false });
  assert.equal(updates.barsHeld, 16);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].exitKind, 'time');
});

test('onBar: time stop fires only without +0.5R progress', () => {
  const stale = position({ barsHeld: scalp.timeStopBars - 1, mfeR: 0.2 });
  assert.equal(onBar(stale, bar({}), scalp, cfg).fills[0]?.exitKind, 'time');
  const working = position({ barsHeld: scalp.timeStopBars - 1, mfeR: 0.8 });
  assert.equal(onBar(working, bar({}), scalp, cfg).fills.length, 0);
});

test('onBar: close below EMA50 exits on trend break', () => {
  const { fills } = onBar(position(), bar({ close: 99, ema50: 99.5 }), scalp, { ...cfg, trendExit: true });
  assert.equal(fills[0].exitKind, 'trend');
  assert.equal(onBar(position(), bar({ close: 99, ema50: 99.5 }), scalp, cfg).fills.length, 0);
});

test('ledger: partial then final sell nets the whole trade and R multiple', () => {
  const pf = createPortfolio(100_000_000);
  openPositionQty(pf, { symbol: 'X', profile: 'scalping', setup: 'pullback', quantity: 10, entryPrice: 100, stopPrice: 98, riskIdr: 20 * RATE, score: 60, timeMs: 0, barTime: 0, usdIdrRate: RATE, roundTripCostPct: 0 });
  const first = sellPosition(pf, { symbol: 'X', quantity: 5, price: 102, timeMs: 1, usdIdrRate: RATE, roundTripCostPct: 0 });
  assert.equal(first.transaction.partial, true);
  const last = sellPosition(pf, { symbol: 'X', price: 104, timeMs: 2, usdIdrRate: RATE, roundTripCostPct: 0 });
  assert.equal(last.closed, true);
  assert.equal(last.tradeRealizedIdr, (5 * 2 + 5 * 4) * RATE);
  assert.equal(last.transaction.rMultiple, 1.5);
  assert.equal(pf.balanceIdr, 100_000_000 + 30 * RATE);
  assert.equal(bookEquityIdr(pf), pf.balanceIdr);
});

test('risk: daily loss halts entries for the rest of the local day', () => {
  const risk = createRiskState();
  const day = Date.UTC(2026, 0, 5, 3);
  updateRisk(risk, 10_000_000, day, cfg);
  const event = updateRisk(risk, 9_790_000, day + 60_000, cfg);
  assert.equal(event?.kind, 'daily-loss');
  assert.ok(entryBlock(risk, day + 120_000, cfg));
  assert.equal(entryBlock(risk, day + 24 * 3_600_000, cfg), null);
});

test('risk: losing streak pauses entries', () => {
  const risk = createRiskState();
  for (let n = 0; n < cfg.maxConsecutiveLosses; n += 1) recordTradeResult(risk, -1, 1_000, cfg);
  assert.ok(entryBlock(risk, 2_000, cfg));
  assert.equal(entryBlock(risk, 1_000 + cfg.streakPauseMs + 1, cfg), null);
});

const START = Date.UTC(2025, 0, 1);
const BARS = 96 * 120;
const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
const full = syntheticSeries({ symbols, bars: BARS, startMs: START, seedBase: 7 });
const tradeStart = START + 40 * 86_400_000;
const end = START + BARS * TF_MS['15m'];

function strip(transactions) {
  return transactions.map(({ id, tradeId, createdAt, balanceAfterIdr, ...rest }) => ({ ...rest, balanceAfterIdr: Math.round(balanceAfterIdr) }));
}

test('core: synthetic history produces trades and conserves money', () => {
  const pf = createPortfolio(10_000_000);
  const out = advance(createEngineState(), pf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg, tradeSymbols: symbols, keepAllTransactions: true });
  const buys = out.transactions.filter((t) => t.type === 'BUY');
  assert.ok(buys.length >= 5, `only ${buys.length} entries`);
  const realized = out.transactions.filter((t) => t.type === 'SELL').reduce((s, t) => s + t.realizedProfitIdr, 0);
  assert.ok(Math.abs(bookEquityIdr(pf) - (10_000_000 + realized)) < 5);
  for (const t of buys) assert.ok(t.stopPrice < t.price, 'stop below entry');
});

test('core: advancing in small steps equals one pass (catch-up parity)', () => {
  const onePf = createPortfolio(10_000_000);
  const one = advance(createEngineState(), onePf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg, tradeSymbols: symbols, keepAllTransactions: true });

  const stepPf = createPortfolio(10_000_000);
  const stepState = createEngineState();
  const stepTx = [];
  for (let now = tradeStart + 7 * 3_600_000; ; now += 7 * 3_600_000) {
    const at = Math.min(now, end);
    const out = advance(stepState, stepPf, cutSeries(full, at), { nowMs: at, startMs: tradeStart, usdIdrRate: RATE, cfg, tradeSymbols: symbols, keepAllTransactions: true });
    stepTx.push(...out.transactions);
    if (at === end) break;
  }
  assert.deepEqual(strip(stepTx), strip(one.transactions));
});

test('core live mode: stops replay after a gap but stale entries are skipped', () => {
  const pf = createPortfolio(10_000_000);
  const state = createEngineState();
  const firstNow = tradeStart + 10 * 86_400_000;
  advance(state, pf, cutSeries(full, firstNow), { nowMs: firstNow, live: true, usdIdrRate: RATE, cfg, tradeSymbols: symbols });
  const later = firstNow + 3 * 86_400_000;
  const out = advance(state, pf, cutSeries(full, later), { nowMs: later, live: true, usdIdrRate: RATE, cfg, tradeSymbols: symbols });
  for (const t of out.transactions.filter((x) => x.type === 'BUY')) {
    const tf = PROFILES[t.profile].triggerTf;
    assert.ok(t.barTime * 1000 + TF_MS[tf] > later - TF_MS[tf], 'BUY only on the latest closed bar');
  }
  assert.ok(out.signals.every((s) => s.taken || s.skip));
});

test('core: at most maxNewEntriesPerBar positions open on one bar close', () => {
  const pf = createPortfolio(10_000_000);
  const out = advance(createEngineState(), pf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg, tradeSymbols: symbols, keepAllTransactions: true });
  const perBar = new Map();
  for (const s of out.signals.filter((x) => x.taken)) {
    const key = s.barTime * 1000 + TF_MS[s.tf];
    perBar.set(key, (perBar.get(key) || 0) + 1);
  }
  assert.ok(perBar.size > 0);
  for (const n of perBar.values()) assert.ok(n <= cfg.maxNewEntriesPerBar);
});

test('core live mode: a tick long after the bar close records the entry as missed', () => {
  const pf = createPortfolio(10_000_000);
  const state = createEngineState();
  const lateCfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0, maxEntryDelayBarFrac: 0 });
  let sawSignal = false;
  for (let now = tradeStart + 10 * 86_400_000; now < end; now += TF_MS['4h']) {
    const out = advance(state, pf, cutSeries(full, now + 60_000), { nowMs: now + 60_000, live: true, usdIdrRate: RATE, cfg: lateCfg, tradeSymbols: symbols });
    assert.equal(out.transactions.filter((t) => t.type === 'BUY').length, 0);
    if (out.signals.some((s) => s.skip?.startsWith('missed-late'))) sawSignal = true;
  }
  assert.ok(sawSignal, 'expected at least one late signal');
});

// The synthetic series has no 5m candles, so these run the early check on 15m.
const earlyCfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0, earlyEntry: true, earlyTf: '15m' });

test('core early entry: buys between trigger closes and conserves money', () => {
  const pf = createPortfolio(10_000_000);
  const out = advance(createEngineState(), pf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg: earlyCfg, tradeSymbols: symbols, keepAllTransactions: true });
  const buys = out.transactions.filter((t) => t.type === 'BUY');
  const early = buys.filter((t) => t.reason.includes('Bought early'));
  assert.ok(early.length > 0, 'no early entries');
  for (const t of early) assert.ok(Date.parse(t.createdAt) % TF_MS[PROFILES[t.profile].triggerTf] !== 0, 'early fill lands between closes');
  const realized = out.transactions.filter((t) => t.type === 'SELL').reduce((s, t) => s + t.realizedProfitIdr, 0);
  assert.ok(Math.abs(bookEquityIdr(pf) - (10_000_000 + realized)) < 5);
  const keys = out.signals.map((s) => `${s.symbol}|${s.profile}|${s.barTime}`);
  assert.equal(new Set(keys).size, keys.length, 'one decision per trigger candle');
});

test('core early entry: advancing in small steps equals one pass', () => {
  const one = advance(createEngineState(), createPortfolio(10_000_000), full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg: earlyCfg, tradeSymbols: symbols, keepAllTransactions: true });
  const stepPf = createPortfolio(10_000_000);
  const stepState = createEngineState();
  const stepTx = [];
  for (let now = tradeStart + 5 * 3_600_000; ; now += 5 * 3_600_000) {
    const at = Math.min(now, end);
    stepTx.push(...advance(stepState, stepPf, cutSeries(full, at), { nowMs: at, startMs: tradeStart, usdIdrRate: RATE, cfg: earlyCfg, tradeSymbols: symbols, keepAllTransactions: true }).transactions);
    if (at === end) break;
  }
  assert.deepEqual(strip(stepTx), strip(one.transactions));
});


// Exit checks on every 15m candle for the 4h/daily profiles (no 5m candles here).
const exitCfg = resolveEngineCfg({ profiles: { swing: true, trend: true, breakout: false }, minTradeQuoteVolumeUsdt: 0, exitTf: '15m', targetR: 1.5 });

test('core exit candles: stops and targets fill between trigger closes and money is conserved', () => {
  const pf = createPortfolio(10_000_000);
  const out = advance(createEngineState(), pf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg: exitCfg, tradeSymbols: symbols, keepAllTransactions: true });
  const sells = out.transactions.filter((t) => t.type === 'SELL' && ['stop', 'target'].includes(t.exitKind));
  assert.ok(sells.length > 0, 'no stop or target exits');
  assert.ok(sells.some((t) => Date.parse(t.createdAt) % TF_MS[PROFILES[t.profile].triggerTf] !== 0), 'expected exits between trigger closes');
  const buyTimes = new Map(out.transactions.filter((t) => t.type === 'BUY').map((t) => [t.tradeId, Date.parse(t.createdAt)]));
  for (const t of sells) if (buyTimes.has(t.tradeId)) assert.ok(Date.parse(t.createdAt) > buyTimes.get(t.tradeId), 'exit after entry');
  const realized = out.transactions.filter((t) => t.type === 'SELL').reduce((s, t) => s + t.realizedProfitIdr, 0);
  assert.ok(Math.abs(bookEquityIdr(pf) - (10_000_000 + realized)) < 5);
});

test('core exit candles: advancing in small steps equals one pass', () => {
  const one = advance(createEngineState(), createPortfolio(10_000_000), full, { nowMs: end, startMs: tradeStart, usdIdrRate: RATE, cfg: exitCfg, tradeSymbols: symbols, keepAllTransactions: true });
  const stepPf = createPortfolio(10_000_000);
  const stepState = createEngineState();
  const stepTx = [];
  for (let now = tradeStart + 5 * 3_600_000; ; now += 5 * 3_600_000) {
    const at = Math.min(now, end);
    stepTx.push(...advance(stepState, stepPf, cutSeries(full, at), { nowMs: at, startMs: tradeStart, usdIdrRate: RATE, cfg: exitCfg, tradeSymbols: symbols, keepAllTransactions: true }).transactions);
    if (at === end) break;
  }
  assert.deepEqual(strip(stepTx), strip(one.transactions));
});
