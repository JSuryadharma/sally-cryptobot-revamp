import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TF_MS } from '../src/engine/config.js';
import { tradeOutcome, stats, research, RULES, TARGETS_R } from '../scripts/entryResearch.mjs';
import { syntheticSeries } from './helpers.mjs';

const b = (open, high, low, close) => ({ open, high, low, close });
const opts = { targetR: 2, maxBars: 3, costPct: 0 };

test('tradeOutcome: stop is checked before the target in the same bar', () => {
  const out = tradeOutcome([b(100, 100, 100, 100), b(100, 105, 97, 101)], 0, { entry: 100, stop: 98 }, opts);
  assert.deepEqual(out, { r: -1, exitIndex: 1 });
});

test('tradeOutcome: gaps fill at the open, time exit at the close, costs in R', () => {
  const gapDown = tradeOutcome([b(100, 100, 100, 100), b(96, 97, 95, 96)], 0, { entry: 100, stop: 98 }, opts);
  assert.equal(gapDown.r, -2);
  const flat = [b(100, 100, 100, 100), b(100, 101, 99, 100), b(100, 101, 99, 100), b(100, 101, 99, 101)];
  assert.deepEqual(tradeOutcome(flat, 0, { entry: 100, stop: 98 }, opts), { r: 0.5, exitIndex: 3 });
  const costly = tradeOutcome(flat, 0, { entry: 100, stop: 98 }, { ...opts, costPct: 0.4 });
  assert.ok(Math.abs(costly.r - 0.3) < 1e-9);
  assert.equal(tradeOutcome(flat.slice(0, 2), 0, { entry: 100, stop: 98 }, opts), null, 'data ended before an exit');
});

test('stats: win rate, average, profit factor and t-stat', () => {
  const s = stats([2, -1, 2, -1]);
  assert.equal(s.n, 4);
  assert.equal(s.winPct, 50);
  assert.equal(s.avgR, 0.5);
  assert.equal(s.pf, 2);
  assert.ok(s.t > 0);
  assert.equal(stats([]).n, 0);
});

test('research: every rule and target reports train and test on synthetic history', () => {
  const START = Date.UTC(2024, 0, 1);
  const BARS = 96 * 420;
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'BTCUSDT'];
  const series = syntheticSeries({ symbols, bars: BARS, startMs: START, seedBase: 3 });
  const startMs = START + 210 * 86_400_000;
  const endMs = START + BARS * TF_MS['15m'];
  const results = research(series, { symbols, startMs, endMs, splitMs: startMs + 0.6 * (endMs - startMs), costPct: 0.3 });
  assert.equal(results.length, RULES.length);
  for (const r of results) assert.deepEqual(r.rows.map((row) => row.targetR), TARGETS_R);
  const traded = results.flatMap((r) => r.rows).reduce((s, row) => s + row.train.n + row.test.n, 0);
  assert.ok(traded > 0, 'some rule traded');
});
