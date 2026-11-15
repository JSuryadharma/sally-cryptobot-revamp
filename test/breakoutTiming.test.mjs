import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, TF_MS } from '../src/engine/config.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { advance, createEngineState, breakoutMode } from '../src/engine/core.js';
import { syntheticSeries } from './helpers.mjs';

const START = Date.UTC(2024, 0, 1);
const BARS = 96 * 420;
const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
const series = syntheticSeries({ symbols: [...symbols, 'BTCUSDT'], bars: BARS, startMs: START, seedBase: 3 });
const startMs = START + 210.5 * 86_400_000;
const endMs = START + BARS * TF_MS['15m'];

function run(breakoutEntry) {
  const cfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0, earlyTf: '15m', exitTf: '15m', breakoutEntry });
  const out = advance(createEngineState(), createPortfolio(10_000_000), series, { nowMs: endMs, startMs, usdIdrRate: 16_000, cfg, tradeSymbols: symbols, keepAllTransactions: true });
  return out.transactions.filter((t) => t.type === 'BUY');
}

const dayMs = TF_MS['1d'];
const priorHigh = (symbol, buyMs, n = 20) => {
  const daily = series[symbol]['1d'].filter((b) => b.time * 1000 + dayMs <= buyMs);
  return Math.max(...daily.slice(-n).map((b) => b.high));
};

test('breakoutMode parses the timing setting', () => {
  assert.deepEqual(breakoutMode({}), { kind: 'close', holdMs: 0 });
  assert.deepEqual(breakoutMode({ breakoutEntry: 'hold:4' }), { kind: 'hold', holdMs: 4 * 3_600_000 });
  assert.equal(breakoutMode({ breakoutEntry: 'nonsense' }).kind, 'close');
});

test('daily-close timings buy on the close; live timings buy mid-day above the level', () => {
  const close = run('close');
  const next = run('nextClose');
  assert.ok(close.length > 0 && next.length > 0);
  for (const t of [...close, ...next]) assert.equal(Date.parse(t.createdAt) % dayMs, 0);
  for (const mode of ['touch', 'hold:4']) {
    const buys = run(mode);
    assert.ok(buys.length > 0, `${mode} buys`);
    assert.ok(buys.some((t) => Date.parse(t.createdAt) % dayMs !== 0), `${mode} buys mid-day`);
    for (const t of buys) assert.ok(t.price > priorHigh(t.symbol, Date.parse(t.createdAt)), `${mode} buys above the level`);
  }
});

test('a hold buys later than the first touch of the same breakout', () => {
  const touch = run('touch');
  const hold = run('hold:4');
  const first = new Map(touch.map((t) => [`${t.symbol}@${Math.floor((Date.parse(t.createdAt) - 1) / dayMs)}`, Date.parse(t.createdAt)]));
  let compared = 0;
  let later = 0;
  for (const t of hold) {
    const at = first.get(`${t.symbol}@${Math.floor((Date.parse(t.createdAt) - 1) / dayMs)}`);
    if (at == null) continue;
    compared += 1;
    assert.ok(Date.parse(t.createdAt) >= at, "never before the first touch");
    if (Date.parse(t.createdAt) - at >= 4 * 3_600_000 - TF_MS['15m']) later += 1;
  }
  assert.ok(compared > 0 && later >= compared / 2, `${later} of ${compared} held 4h after the touch`);
});
