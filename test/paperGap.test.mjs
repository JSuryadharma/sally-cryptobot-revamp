import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichCandles } from '../src/indicators.js';
import { gapAt, reboundAt, reboundPlan, followGapTrade, updateGapJournal, gapResult, summarizeGap } from '../src/engine/paperGap.js';

const DAY = 86_400;
const HOUR = 3_600;
const T0 = Date.UTC(2026, 0, 1) / 1000;

// 40 calm daily bars around 100, then a 3-day drop that leaves a gap on day 40
// (day 40's high 88 is below day 38's low 96).
function dailyWithGap({ gapVolume = 5000 } = {}) {
  const bars = [];
  for (let k = 0; k < 38; k += 1) bars.push({ time: T0 + k * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  bars.push({ time: T0 + 38 * DAY, open: 100, high: 101, low: 96, close: 97, volume: 1500 });
  bars.push({ time: T0 + 39 * DAY, open: 97, high: 97.5, low: 89, close: 90, volume: 1500 });
  bars.push({ time: T0 + 40 * DAY, open: 90, high: 88 + 0, low: 82, close: 83, volume: gapVolume });
  bars[40].open = 87.5; // red candle fully under the gap
  return enrichCandles(bars);
}

// Hourly candles after the gap day: keep falling to an oversold low, then bounce.
function hourlyAfter(daily, { bounceTo = 95 } = {}) {
  const start = daily[40].time + DAY - 60 * HOUR; // 60 hours of history before the gap closed
  const closes = [];
  for (let h = 0; h < 60; h += 1) closes.push(86 - h * 0.05);
  for (let h = 0; h < 20; h += 1) closes.push(83 - h * 0.25); // sell-off: RSI under 30
  for (let h = 0; h < 6; h += 1) closes.push(78 + h * 0.05);
  for (let h = 0; h < 10; h += 1) closes.push(78.5 + h * 0.6); // rebound through the EMA20
  for (let h = 0; h < 200; h += 1) closes.push(Math.min(bounceTo, 84.5 + h * 0.2));
  return enrichCandles(closes.map((close, h) => {
    const open = h ? closes[h - 1] : close;
    return { time: start + h * HOUR, open, close, high: Math.max(open, close) + 0.05, low: Math.min(open, close) - 0.05, volume: 100 };
  }));
}

test('gapAt: needs a 3-candle gap, a red day and 2x volume', () => {
  const d = dailyWithGap();
  const gap = gapAt(d, 40);
  assert.ok(gap);
  assert.equal(gap.bottom, 88);
  assert.equal(gap.top, 96);
  assert.ok(gap.volX >= 2);
  assert.equal(gapAt(dailyWithGap({ gapVolume: 1500 }), 40), null);
  assert.equal(gapAt(d, 39), null);
});

test('reboundAt + plan: first close back above EMA20 after RSI was under 30', () => {
  const d = dailyWithGap();
  const h = hourlyAfter(d);
  const hits = h.map((_, i) => reboundAt(h, i)).map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  assert.ok(hits.length >= 1);
  const plan = reboundPlan(h, hits[0]);
  assert.ok(plan.entry > plan.stop);
  assert.ok(plan.exitStop >= plan.entry * 0.85 - 1e-9);
  assert.ok(Math.abs(plan.target - (plan.entry + 1.5 * (plan.entry - plan.stop))) < 1e-9);
});

test('followGapTrade: target, max-loss cap and time stop', () => {
  const bar = (time, low, high, close = (low + high) / 2) => ({ time, open: close, low, high, close });
  const hourly = [bar(0, 99, 101, 100)];
  const plan = { entry: 100, stop: 70, exitStop: 85, target: 145 };
  const crash = [...hourly, bar(HOUR, 80, 100)];
  const lost = followGapTrade(crash, 0, plan);
  assert.equal(lost.status, 'maxloss');
  assert.equal(lost.exitPrice, 85);
  const win = followGapTrade([...hourly, bar(HOUR, 95, 150)], 0, plan);
  assert.equal(win.status, 'target');
  const flat = [hourly[0], ...Array.from({ length: 200 }, (_, k) => bar((k + 1) * HOUR, 99, 101, 100.5))];
  assert.equal(followGapTrade(flat, 0, plan).status, 'time');
  assert.equal(followGapTrade(flat.slice(0, 50), 0, plan).status, 'open');
});

test('updateGapJournal: records one paper trade per gap, follows it, and scores it', () => {
  const d = dailyWithGap();
  const full = hourlyAfter(d);
  const symbols = ['AAAUSDT'];
  // Live: grow the hourly history one bar at a time.
  let journal = [];
  for (let len = 70; len <= full.length; len += 1) {
    journal = updateGapJournal(journal, { AAAUSDT: { '1d': d, '1h': full.slice(0, len) } }, symbols);
  }
  assert.equal(journal.length, 1);
  const [record] = journal;
  assert.equal(record.gapTime, d[40].time);
  assert.notEqual(record.status, 'open');
  // A replay over the full history gives the same trade.
  const replay = updateGapJournal([], { AAAUSDT: { '1d': d, '1h': full } }, symbols);
  assert.deepEqual(replay, journal);
  const res = gapResult(record, 0.3);
  assert.ok(res);
  const summary = summarizeGap(journal, { costPct: 0.3 });
  assert.equal(summary.closed, 1);
  assert.equal(summary.signals, 1);
});
