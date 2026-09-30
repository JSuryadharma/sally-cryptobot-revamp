import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg } from '../src/engine/config.js';
import { enrichCandles } from '../src/indicators.js';
import { breakoutPlan, btcAbove200d, updatePaperJournal, paperR, summarizePaper, paperCostPct, PAPER_RULES } from '../src/engine/paperBreakout.js';
import { mulberry32 } from './helpers.mjs';

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000;
const [RULE20, RULE55] = PAPER_RULES;

// Daily candles from a list of closes, each bar spanning +-1% around its open/close.
function daily(closes) {
  return enrichCandles(closes.map((close, k) => {
    const open = k ? closes[k - 1] : close;
    return { time: T0 + k * DAY, open, close, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, volume: 1 };
  }));
}

const rising = (n, from = 100, step = 0.2) => Array.from({ length: n }, (_, k) => from + k * step);
const walk = (n, seed) => {
  const rand = mulberry32(seed);
  const out = [100];
  for (let k = 1; k < n; k += 1) out.push(out[k - 1] * (1 + (rand() - 0.47) * 0.06));
  return out;
};

test('btcAbove200d: needs 200 days and a close above their average', () => {
  const up = daily(rising(260));
  assert.equal(btcAbove200d(up, up[150].time), false);
  assert.equal(btcAbove200d(up, up[250].time), true);
  const down = daily(rising(260, 200, -0.3));
  assert.equal(btcAbove200d(down, down[250].time), false);
});

test('breakoutPlan: close above the prior 20-day high, only when BTC is above its 200-day average', () => {
  const flat = Array.from({ length: 230 }, () => 100);
  flat.push(110);
  const coin = daily(flat);
  const i = coin.length - 1;
  const plan = breakoutPlan(coin, i, RULE20, daily(rising(231)));
  assert.ok(plan);
  assert.equal(plan.entry, 110);
  assert.equal(plan.breakoutLevel, 101);
  assert.ok(Math.abs(plan.stop - (110 - 2 * coin[i].atr14)) < 1e-9);
  assert.equal(breakoutPlan(coin, i, RULE20, daily(rising(231, 200, -0.3))), null);
  assert.equal(breakoutPlan(coin, i - 1, RULE20, daily(rising(231))), null);
});

test('updatePaperJournal: following day by day equals a replay of the same window', () => {
  const n = 420;
  const series = { BTCUSDT: { '1d': daily(rising(n)) }, AAAUSDT: { '1d': daily(walk(n, 3)) }, BBBUSDT: { '1d': daily(walk(n, 9)) } };
  const symbols = ['AAAUSDT', 'BBBUSDT'];
  // The first live pass scans days 217-219, so the replay starts at day 217 too.
  const startMs = (T0 + 218 * DAY) * 1000;
  const endMs = (T0 + n * DAY) * 1000;
  const replay = updatePaperJournal([], series, symbols, { window: { startMs, endMs } });

  let live = [];
  for (let len = 220; len <= n; len += 1) {
    const cut = Object.fromEntries(Object.entries(series).map(([s, v]) => [s, { '1d': v['1d'].slice(0, len) }]));
    live = updatePaperJournal(live, cut, symbols);
  }
  assert.ok(replay.length >= 4, `expected several signals, got ${replay.length}`);
  assert.deepEqual(live, replay);
  for (const r of replay) assert.equal(r.taken, false);
});

test('updatePaperJournal: one open paper trade per coin per rule, closed at its target', () => {
  const n = 420;
  const series = { BTCUSDT: { '1d': daily(rising(n)) }, AAAUSDT: { '1d': daily(walk(n, 5)) } };
  const journal = updatePaperJournal([], series, ['AAAUSDT'], { window: { startMs: (T0 + 210 * DAY) * 1000, endMs: (T0 + n * DAY) * 1000 } });
  const bars = series.AAAUSDT['1d'];
  const indexOf = (t) => bars.findIndex((b) => b.time === t);
  // Where the paper trade ended: the first bar at its target, else where the journal stopped following it.
  const exitIndex = (r) => {
    const start = indexOf(r.barTime);
    const target = r.entry + r.targetR * (r.entry - r.stop);
    if (r.mfeR >= r.targetR) return bars.findIndex((b, k) => k > start && b.high >= target);
    return start + r.barsTracked;
  };
  for (const rule of PAPER_RULES) {
    const rows = journal.filter((r) => r.profile === rule.key).reverse();
    assert.ok(rows.length >= 2, `${rule.key}: expected several signals`);
    for (let k = 1; k < rows.length; k += 1) {
      assert.ok(indexOf(rows[k].barTime) > exitIndex(rows[k - 1]), `${rule.key} overlaps at ${k}`);
    }
  }
});

test('paperR: target, stop and time stop results after costs', () => {
  const base = { entry: 100, stop: 98, targetR: 1 };
  const costR = 0.3 / 2;
  assert.equal(paperR({ ...base, status: 'target', mfeR: 2 }, 0.3), 1 - costR);
  assert.equal(paperR({ ...base, status: 'stopped', mfeR: 1.2, exitR: -1 }, 0.3), 1 - costR);
  assert.equal(paperR({ ...base, status: 'stopped', mfeR: 0.4, exitR: -1.5 }, 0.3), -1.5 - costR);
  assert.equal(paperR({ ...base, status: 'expired', mfeR: 0.8, exitR: 0.3 }, 0.3), 0.3 - costR);
  assert.equal(paperR({ ...base, status: 'pending', mfeR: 0.8 }, 0.3), null);
  assert.equal(paperR({ ...base, targetR: 2, status: 'pending', mfeR: 2.1 }, 0.3), 2 - costR);
});

test('summarizePaper: per-rule counts and R', () => {
  const r = (profile, targetR, extra) => ({ symbol: 'X', profile, targetR, barTime: T0, entry: 100, stop: 98, ...extra });
  const journal = [
    r('breakout20', 1, { status: 'target', mfeR: 2 }),
    r('breakout20', 1, { status: 'stopped', mfeR: 0, exitR: -1 }),
    r('breakout20', 1, { status: 'pending', mfeR: 0.2 }),
    r('breakout55', 2, { status: 'expired', mfeR: 1.5, exitR: 0.5 })
  ];
  const cfg = resolveEngineCfg({});
  const s = summarizePaper(journal, { costPct: paperCostPct(cfg) });
  assert.equal(s.costPct, 0.3);
  const [b20, b55] = s.rules;
  assert.deepEqual([b20.signals, b20.closed, b20.open, b20.winPct, b20.totalR], [3, 2, 1, 50, -0.3]);
  assert.deepEqual([b20.hitRate.hits, b20.hitRate.decided], [1, 2]);
  assert.deepEqual([b55.closed, b55.avgR, b55.hitRate.hits], [1, 0.35, 0]);
});
