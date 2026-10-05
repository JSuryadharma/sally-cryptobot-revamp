import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, TF_MS } from '../src/engine/config.js';
import { decideStrategy, decisionChanged, AUTOPILOT_PARAMS } from '../src/engine/autopilot.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { updatePaperJournal, paperResults, paperExitIndex, paperCostPct } from '../src/engine/paperBreakout.js';
import { enrichCandles } from '../src/indicators.js';
import { syntheticSeries } from './helpers.mjs';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 5);
const RATE = 16_000;

// n closed paper trades of `rule` averaging avgR, the newest closed at NOW - 1 day.
function trades(rule, n, avgR, { endMs = NOW - DAY_MS } = {}) {
  return Array.from({ length: n }, (_, k) => ({ rule, r: k % 2 ? avgR + 0.5 : avgR - 0.5, closedAtMs: endMs - k * DAY_MS }))
    .map((t, k, all) => (all.length % 2 && k === all.length - 1 ? { ...t, r: avgR } : t));
}

function btc(closes) {
  return enrichCandles(closes.map((close, k) => ({ time: (NOW - (closes.length - k) * DAY_MS) / 1000, open: close, high: close, low: close, close, volume: 1 })));
}
const btcUp = btc(Array.from({ length: 260 }, (_, k) => 100 + k));
const btcDown = btc(Array.from({ length: 260 }, (_, k) => 400 - k));

test('no paper evidence yet: trades the 20-day breakout', () => {
  const d = decideStrategy({ results: [], btcDaily: btcUp, nowMs: NOW });
  assert.equal(d.chosen, 'breakout');
  assert.equal(d.paused, false);
  assert.equal(d.profiles.breakout, true);
  assert.equal(d.profiles.breakout55, false);
  assert.equal(d.profiles.swing, false);
  assert.deepEqual(d.candidates.map((c) => c.status), ['learning', 'learning']);
  assert.equal(d.regime.btcAbove200d, true);
});

test('a proven 55-day breakout beats a 20-day one that is still learning', () => {
  const d = decideStrategy({ results: [...trades('breakout20', 5, 0.5), ...trades('breakout55', 14, 0.3)], btcDaily: btcUp, nowMs: NOW });
  assert.equal(d.chosen, 'breakout55');
  assert.equal(d.candidates[1].status, 'ok');
  assert.equal(d.candidates[1].avgR, 0.3);
});

test('switches only when the challenger leads by the margin', () => {
  const close = [...trades('breakout20', 20, 0.2), ...trades('breakout55', 20, 0.25)];
  assert.equal(decideStrategy({ results: close, btcDaily: btcUp, nowMs: NOW }).chosen, 'breakout55', 'no previous choice: best wins');
  const kept = decideStrategy({ results: close, btcDaily: btcUp, nowMs: NOW, previous: { chosen: 'breakout' } });
  assert.equal(kept.chosen, 'breakout');
  assert.match(kept.why, /^kept/);
  const clear = [...trades('breakout20', 20, 0.1), ...trades('breakout55', 20, 0.3)];
  assert.equal(decideStrategy({ results: clear, btcDaily: btcUp, nowMs: NOW, previous: { chosen: 'breakout' } }).chosen, 'breakout55');
});

test('a losing strategy is benched; when both lose, new buys pause', () => {
  const one = decideStrategy({ results: [...trades('breakout20', 20, -0.3), ...trades('breakout55', 4, 0.1)], btcDaily: btcUp, nowMs: NOW, previous: { chosen: 'breakout' } });
  assert.equal(one.candidates[0].status, 'benched');
  assert.equal(one.chosen, 'breakout55');
  const both = decideStrategy({ results: [...trades('breakout20', 20, -0.3), ...trades('breakout55', 15, -0.2)], btcDaily: btcUp, nowMs: NOW });
  assert.equal(both.paused, true);
  assert.ok(both.pauseReason);
  assert.equal(both.profiles.breakout, true, 'a profile stays on so signals are still recorded');
  assert.ok(decisionChanged(one, both));
  assert.ok(!decisionChanged(both, { ...both }));
});

test('results closed after the decision time are not used', () => {
  const future = trades('breakout55', 20, 1, { endMs: NOW + 30 * DAY_MS });
  const d = decideStrategy({ results: future, btcDaily: btcUp, nowMs: NOW });
  assert.equal(d.candidates[1].closed, 0);
  assert.equal(d.chosen, 'breakout');
});

test('only the last window of closed trades counts', () => {
  const old = trades('breakout20', 30, -1, { endMs: NOW - 40 * DAY_MS });
  const recent = trades('breakout20', AUTOPILOT_PARAMS.window, 0.2);
  const d = decideStrategy({ results: [...old, ...recent], btcDaily: btcUp, nowMs: NOW });
  assert.equal(d.candidates[0].closed, AUTOPILOT_PARAMS.window);
  assert.equal(d.candidates[0].avgR, 0.2);
});

test('BTC below its 200-day average is reported in the summary', () => {
  const d = decideStrategy({ results: [], btcDaily: btcDown, nowMs: NOW });
  assert.equal(d.regime.btcAbove200d, false);
  assert.match(d.summary, /below its 200-day average/);
});

// A synthetic market long enough for BTC's 200-day average and several breakouts.
const START = Date.UTC(2024, 0, 1);
const BARS = 96 * 420;
const SYMBOLS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
const series = syntheticSeries({ symbols: [...SYMBOLS, 'BTCUSDT'], bars: BARS, startMs: START, seedBase: 3 });
const startMs = START + 210.5 * DAY_MS;
const endMs = START + BARS * TF_MS['15m'];
const loose = (o = {}) => resolveEngineCfg({
  minTradeQuoteVolumeUsdt: 0, slippagePct: 0, maxOpenPositions: 50, maxNewEntriesPerBar: 50, maxPortfolioRiskPct: 100,
  tradeAllocationPct: 0.05, maxConsecutiveLosses: 1000, dailyLossLimitPct: 100, drawdownHaltPct: 100, ...o
});

test('the 55-day engine profile buys exactly the 55-day paper signals', () => {
  const out = advance(createEngineState(), createPortfolio(10_000_000), series, {
    nowMs: endMs, startMs, usdIdrRate: RATE, cfg: loose({ profiles: { breakout: false, breakout55: true } }), tradeSymbols: SYMBOLS, keepAllTransactions: true
  });
  const buys = out.transactions.filter((t) => t.type === 'BUY');
  assert.ok(buys.length >= 1, 'no 55-day entries');
  assert.ok(buys.every((t) => t.profile === 'breakout55'));
  const paper = updatePaperJournal([], series, SYMBOLS, { window: { startMs, endMs } }).filter((r) => r.profile === 'breakout55');
  assert.deepEqual(buys.map((t) => `${t.symbol}|${t.barTime}`).sort(), paper.map((r) => `${r.symbol}|${r.barTime}`).sort());
});

test('an autopilot pause records signals but opens nothing', () => {
  const out = advance(createEngineState(), createPortfolio(10_000_000), series, {
    nowMs: endMs, startMs, usdIdrRate: RATE, cfg: loose({ autopilotPause: 'both losing' }), tradeSymbols: SYMBOLS
  });
  assert.equal(out.transactions.length, 0);
  assert.ok(out.signals.length > 0);
  assert.ok(out.signals.every((s) => s.skip === 'autopilot paused: both losing'));
});

test('advancing one day at a time trades the same as one pass', () => {
  const cfg = loose();
  const once = advance(createEngineState(), createPortfolio(10_000_000), series, {
    nowMs: endMs, startMs, usdIdrRate: RATE, cfg, tradeSymbols: SYMBOLS, keepAllTransactions: true
  });
  const state = createEngineState();
  const portfolio = createPortfolio(10_000_000);
  const stepped = [];
  for (let nowMs = Math.ceil(startMs / DAY_MS) * DAY_MS; ; nowMs = Math.min(nowMs + DAY_MS, endMs)) {
    stepped.push(...advance(state, portfolio, series, { nowMs, startMs, usdIdrRate: RATE, cfg, tradeSymbols: SYMBOLS, keepAllTransactions: true }).transactions);
    if (nowMs >= endMs) break;
  }
  const brief = (t) => `${t.type}|${t.symbol}|${t.barTime}|${t.price}`;
  assert.ok(once.transactions.length > 0);
  assert.deepEqual(stepped.map(brief), once.transactions.map(brief));
});

test('paperResults: each closed paper trade is dated at its exit candle close', () => {
  const journal = updatePaperJournal([], series, SYMBOLS, { window: { startMs: 0, endMs } });
  const results = paperResults(journal, series, { costPct: paperCostPct(resolveEngineCfg()) });
  assert.ok(results.length > 0);
  for (const x of results) {
    const record = journal.find((r) => r.symbol === x.symbol && r.profile === x.rule && r.barTime === x.barTime);
    const daily = series[x.symbol]['1d'];
    assert.equal(x.closedAtMs, daily[paperExitIndex(record, daily)].time * 1000 + DAY_MS);
    assert.ok(x.closedAtMs > x.barTime * 1000 + DAY_MS);
  }
  for (let k = 1; k < results.length; k += 1) assert.ok(results[k - 1].closedAtMs >= results[k].closedAtMs);
});
