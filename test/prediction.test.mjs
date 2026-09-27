import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, TF_MS } from '../src/engine/config.js';
import { predictCoin, describePrediction } from '../src/engine/prediction.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { createRiskState } from '../src/engine/riskGuard.js';

const RATE = 16_000;
const START = Date.UTC(2026, 0, 1) / 1000;
const cfg = resolveEngineCfg({ profiles: { swing: true, trend: false, scalping: false }, btcGate: false, minTradeQuoteVolumeUsdt: 0 });

// Hand-built "enriched" candles: indicator fields are set directly so each
// scenario is exact and readable.
function candle(k, tf, fields) {
  return {
    time: START + (k * TF_MS[tf]) / 1000, open: 100.5, high: 101, low: 100.4, close: 100.8,
    ema20: 100, ema50: 95, atr14: 1, rsi14: 60, adx14: 25, volume: 1e6, volumeSma20: 1e6, ...fields
  };
}

function scenario({ trendUp = true, pullback = true, forming = {} } = {}) {
  const daily = Array.from({ length: 20 }, (_, k) => candle(k, '1d', trendUp
    ? { close: 110, ema20: 105, ema50: 95 + k * 0.3 }
    : { close: 90, ema20: 95, ema50: 100 - k * 0.3 }));
  const closed = Array.from({ length: 30 }, (_, k) => candle(k, '4h', {}));
  if (pullback) {
    closed[27] = candle(27, '4h', { low: 100.1, rsi14: 45 });
    closed[28] = candle(28, '4h', { low: 100.1, rsi14: 47 });
  }
  closed[29] = candle(29, '4h', { high: 101.2, close: 100.8, rsi14: 50 });
  const live = candle(30, '4h', { open: 100.9, high: 101.6, low: 100.8, close: 101.0, rsi14: 52, ema20: 100.7, ...forming });
  return {
    series: { COINUSDT: { '4h': closed, '1d': daily } },
    live: { COINUSDT: { '4h': live } }
  };
}

function predict(s, { portfolio = createPortfolio(10_000_000), autoTradeOn = true, risk = createRiskState() } = {}) {
  return predictCoin({ symbol: 'COINUSDT', ...s, cfg, portfolio, risk, symbolState: null, autoTradeOn, usdIdrRate: RATE, nowMs: (START + 30.5 * 4 * 3600) * 1000 });
}

test('setting-up: pullback done, forming candle still below the trigger', () => {
  const { headline } = predict(scenario());
  assert.equal(headline.stage, 'setting-up');
  assert.equal(headline.trigger.price, 101.2);
  assert.ok(headline.trigger.distancePct > 0);
  assert.equal(headline.decisionAt, (START + 31 * 4 * 3600) * 1000);
  assert.equal(headline.pullbackValidFor, 4);
  assert.ok(headline.plan && headline.plan.stopPrice < headline.plan.entryPrice);
  assert.ok(headline.plan.riskIdr > 0 && headline.plan.riskIdr <= 75_000 + 1);
  assert.match(describePrediction(headline, 'COINUSDT'), /^Setting up: buys if the 4-hour candle closes above 101.2/);
});

test('ready: the forming candle passes every condition right now', () => {
  const { headline } = predict(scenario({ forming: { close: 101.5, rsi14: 55 } }));
  assert.equal(headline.stage, 'ready');
  assert.equal(headline.met, headline.total);
  assert.ok(headline.score != null);
});

test('overextended candle does not count as ready', () => {
  const { headline } = predict(scenario({ forming: { close: 102.5, high: 102.6, rsi14: 60 } }));
  assert.equal(headline.stage, 'setting-up');
  assert.equal(headline.conditions.find((c) => c.key === 'noChase').ok, false);
});

test('watching: uptrend but no pullback yet', () => {
  const { headline } = predict(scenario({ pullback: false }));
  assert.equal(headline.stage, 'watching');
  assert.equal(headline.plan, null);
});

test('blocked: the daily trend is down', () => {
  const { headline } = predict(scenario({ trendUp: false }));
  assert.equal(headline.stage, 'blocked');
  assert.match(describePrediction(headline, 'COINUSDT'), /daily trend is not up/);
});

test('blockers explain why a ready setup would not fire', () => {
  const risk = createRiskState();
  risk.haltedUntilMs = Date.now() * 2;
  risk.haltReason = '3 losing trades in a row';
  const { headline } = predict(scenario({ forming: { close: 101.5, rsi14: 55 } }), { autoTradeOn: false, risk });
  assert.equal(headline.canFire, false);
  assert.ok(headline.blockers.some((b) => b.includes('Auto-trade is off')));
  assert.ok(headline.blockers.some((b) => b.includes('3 losing trades')));
});

test('holding: exit plan shows stop distance and the breakeven arm price', () => {
  const portfolio = createPortfolio(10_000_000);
  portfolio.positions.COINUSDT = {
    symbol: 'COINUSDT', profile: 'swing', quantity: 10, entryPrice: 100, stopPrice: 98, initialStop: 98,
    highWaterMark: 100, barsHeld: 2, partialTaken: false, mfeR: 0.2, investedIdr: 100 * 10 * RATE,
    openedBarTime: START + 28 * 4 * 3600, tradeId: 't1', riskIdr: 20 * 10 * RATE
  };
  const { headline, exit } = predict(scenario(), { portfolio });
  assert.equal(headline.stage, 'holding');
  assert.equal(exit.breakevenArmPrice, 102);
  assert.equal(exit.stopKind, 'initial');
  assert.equal(exit.rNow, 0.5);
  assert.ok(exit.timeStopAt > 0);
});
