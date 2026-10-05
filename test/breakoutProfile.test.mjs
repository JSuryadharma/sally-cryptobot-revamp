import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineCfg, PROFILES, TF_MS } from '../src/engine/config.js';
import { onBar } from '../src/engine/positionManager.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { updatePaperJournal } from '../src/engine/paperBreakout.js';
import { normalize, engineCfgFromSettings } from '../src/settings.js';
import { syntheticSeries } from './helpers.mjs';

const RATE = 16_000;
const breakout = PROFILES.breakout;
const cfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0 });
const position = (o = {}) => ({
  symbol: 'X', profile: 'breakout', quantity: 1, entryPrice: 100, stopPrice: 96, initialStop: 96,
  highWaterMark: 100, barsHeld: 0, partialTaken: false, mfeR: 0, investedIdr: 100 * RATE, ...o
});
const bar = (o) => ({ time: 0, open: 101, high: 102, low: 99, close: 101, atr14: 2, ema50: 90, ...o });

test('breakout is the only strategy on by default', () => {
  assert.deepEqual(cfg.profiles, { scalping: false, swing: false, trend: false, breakout: true, breakout55: false });
});

test('strategy switches are no longer settings: the autopilot decision sets the profiles', () => {
  const old = normalize({ strategiesVersion: 2, strategies: { swing: true, breakout: false }, earlyEntry: true, autoTrade: { enabled: true, minConfidencePct: 60, scoreVersion: 2 } });
  assert.equal(old.strategies, undefined);
  assert.equal(old.earlyEntry, undefined);
  assert.deepEqual(old.autoTrade, { enabled: true });
  const none = engineCfgFromSettings(old);
  assert.deepEqual(none.profiles, cfg.profiles);
  assert.equal(none.earlyEntry, false);
  assert.equal(none.minConfidencePct, 0);
  const picked = engineCfgFromSettings(old, { profiles: { breakout: false, breakout55: true }, paused: true, pauseReason: 'losing' });
  assert.deepEqual(picked.profiles, { breakout: false, breakout55: true });
  assert.equal(picked.autopilotPause, 'losing');
});

test('breakout exits: sells at +1R, no breakeven move or trail', () => {
  const hit = onBar(position(), bar({ high: 104.5 }), breakout, cfg);
  assert.equal(hit.fills[0].exitKind, 'target');
  assert.equal(hit.fills[0].price, 104);
  const gap = onBar(position(), bar({ open: 105, high: 106, low: 104.5 }), breakout, cfg);
  assert.equal(gap.fills[0].price, 105, 'gap above the target fills at the open');
  const near = onBar(position(), bar({ high: 103.9 }), breakout, cfg);
  assert.equal(near.fills.length, 0);
  assert.equal(near.updates.stopPrice, 96, 'stop never moves');
});

test('breakout exits: time stop after 30 days even when in profit', () => {
  const { fills } = onBar(position({ barsHeld: 29, mfeR: 0.9 }), bar({ close: 103 }), breakout, cfg);
  assert.equal(fills[0].exitKind, 'time');
});

test('engine breakout trades match the paper test trade for trade', () => {
  const START = Date.UTC(2024, 0, 1);
  const BARS = 96 * 420;
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
  const series = syntheticSeries({ symbols: [...symbols, 'BTCUSDT'], bars: BARS, startMs: START, seedBase: 3 });
  const startMs = START + 210.5 * 86_400_000;
  const endMs = START + BARS * TF_MS['15m'];
  const loose = resolveEngineCfg({
    minTradeQuoteVolumeUsdt: 0, slippagePct: 0, maxOpenPositions: 50, maxNewEntriesPerBar: 50, maxPortfolioRiskPct: 100,
    tradeAllocationPct: 0.05, maxConsecutiveLosses: 1000, dailyLossLimitPct: 100, drawdownHaltPct: 100
  });
  const out = advance(createEngineState(), createPortfolio(10_000_000), series, {
    nowMs: endMs, startMs, usdIdrRate: RATE, cfg: loose, tradeSymbols: symbols, keepAllTransactions: true
  });
  const buys = out.transactions.filter((t) => t.type === 'BUY');
  assert.ok(buys.length >= 3, `only ${buys.length} breakout entries`);
  assert.ok(buys.every((t) => t.profile === 'breakout'));

  const paper = updatePaperJournal([], series, symbols, { window: { startMs, endMs } }).filter((r) => r.profile === 'breakout20');
  const key = (symbol, barTime) => `${symbol}|${barTime}`;
  const engineEntries = buys.map((t) => key(t.symbol, t.barTime)).sort();
  const paperEntries = paper.map((r) => key(r.symbol, r.barTime)).sort();
  assert.deepEqual(engineEntries, paperEntries);

  const sells = out.transactions.filter((t) => t.type === 'SELL');
  for (const r of paper.filter((p) => p.status !== 'pending')) {
    const sell = sells.find((t) => t.symbol === r.symbol && t.barTime > r.barTime);
    const expected = r.mfeR >= 1 ? 'target' : r.status === 'stopped' ? 'stop' : 'time';
    assert.equal(sell?.exitKind, expected, `${r.symbol} ${r.barTime}`);
  }
});
