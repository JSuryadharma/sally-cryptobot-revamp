import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, TF_MS } from '../src/engine/config.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { trackOutcome, updateJournal, signalRecords, summarizeOutcomes, scoreAuc, outcomeAt } from '../src/engine/outcomes.js';
import { syntheticSeries, cutSeries } from './helpers.mjs';

const RATE = 16_000;
const cfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0 });
const b = (time, low, high) => ({ time, open: (low + high) / 2, high, low, close: (low + high) / 2 });
const plan = { entry: 100, stop: 98, maxBars: 10 };

test('trackOutcome: a bar touching both stop and target counts as stopped', () => {
  const r = trackOutcome([b(1, 97, 105)], 0, plan);
  assert.equal(r.status, 'stopped');
  assert.equal(r.mfeR, 0);
});

test('trackOutcome: reaching +1R then the stop is a 1R hit and a 2R miss', () => {
  const r = trackOutcome([b(1, 99, 102.5), b(2, 97.5, 100)], 0, plan);
  assert.equal(r.status, 'stopped');
  assert.equal(r.mfeR, 1.25);
  assert.equal(outcomeAt(r, 1), 'hit');
  assert.equal(outcomeAt(r, 2), 'miss');
});

test('trackOutcome: stops following at +2R, the time limit, or the end of data', () => {
  assert.equal(trackOutcome([b(1, 99, 104.5)], 0, plan).status, 'target');
  const flat = Array.from({ length: 12 }, (_, k) => b(k, 99, 101));
  const expired = trackOutcome(flat, 0, plan);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.barsTracked, 10);
  const pending = trackOutcome(flat.slice(0, 3), 0, plan);
  assert.equal(pending.status, 'pending');
  assert.equal(outcomeAt(pending, 1), 'open');
});

test('updateJournal: following bar by bar equals one pass, and repeats are ignored', () => {
  const bars = [b(0, 99, 100), b(1, 99, 101), b(2, 99.5, 102.2), b(3, 99, 103), b(4, 97, 99)];
  const rec = () => ({ symbol: 'X', profile: 'swing', tf: '4h', barTime: 0, score: 60, entry: 100, stop: 98, maxBars: 10, status: 'pending', mfeR: 0, barsTracked: 0 });
  const once = updateJournal([], [rec()], { X: { '4h': bars } });
  let step = [];
  for (let n = 1; n <= bars.length; n += 1) step = updateJournal(step, [rec()], { X: { '4h': bars.slice(0, n) } });
  assert.equal(step.length, 1);
  assert.deepEqual(step, once);
  assert.equal(once[0].status, 'stopped');
  assert.equal(once[0].mfeR, 1.5);
});

test('scoreAuc: 100 when higher scores always hit, 50 when unrelated', () => {
  const r = (score, mfeR) => ({ score, mfeR, status: 'stopped' });
  assert.equal(scoreAuc([r(80, 1.5), r(70, 1.2), r(40, 0.2), r(30, 0)], 1), 100);
  assert.equal(scoreAuc([r(50, 1.5), r(50, 0)], 1), 50);
  assert.equal(scoreAuc([r(50, 1.5)], 1), null);
});

test('backtest signals carry a price plan and are summarised', () => {
  const START = Date.UTC(2025, 0, 1);
  const BARS = 96 * 120;
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
  const series = syntheticSeries({ symbols, bars: BARS, startMs: START, seedBase: 7 });
  const end = START + BARS * TF_MS['15m'];
  const out = advance(createEngineState(), createPortfolio(10_000_000), series, {
    nowMs: end, startMs: START + 40 * 86_400_000, usdIdrRate: RATE, cfg, tradeSymbols: symbols, keepAllTransactions: true
  });
  assert.ok(out.signals.length > 0);
  for (const s of out.signals) {
    assert.equal(typeof s.profile, 'string');
    assert.ok(s.entryPrice > s.stopPrice, 'entry above stop');
  }
  const records = signalRecords(out.signals, cfg);
  assert.equal(records.length, out.signals.length);
  const summary = summarizeOutcomes(updateJournal([], records, series, { maxRecords: Infinity }));
  const one = summary.levels['1R'];
  assert.equal(summary.signals, records.length);
  assert.ok(one.overall.decided > 0);
  assert.equal(one.byScore.reduce((s, x) => s + x.decided, 0), one.overall.decided);
  assert.equal(one.taken.decided + one.skipped.decided, one.overall.decided);
});

test('live journal: records survive between ticks and resolve later', () => {
  const START = Date.UTC(2025, 0, 1);
  const BARS = 96 * 120;
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
  const full = syntheticSeries({ symbols, bars: BARS, startMs: START, seedBase: 7 });
  const state = createEngineState();
  const pf = createPortfolio(10_000_000);
  let journal = [];
  for (let at = START + 40 * 86_400_000; at <= START + BARS * TF_MS['15m']; at += TF_MS['4h']) {
    const series = cutSeries(full, at);
    const out = advance(state, pf, series, { nowMs: at, live: true, usdIdrRate: RATE, cfg, tradeSymbols: symbols });
    journal = updateJournal(journal, signalRecords(out.signals, cfg), series);
  }
  assert.ok(journal.length > 0);
  assert.ok(journal.some((r) => r.status !== 'pending'), 'some signals resolved');
  assert.equal(new Set(journal.map((r) => `${r.symbol}|${r.profile}|${r.barTime}`)).size, journal.length);
});
