import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/settings.js';
import { DEFAULT_ENGINE_CFG } from '../src/engine/config.js';

const OLD = { riskPerTradePct: 0.75, maxPortfolioRiskPct: 3, maxOpenPositions: 4, dailyLossLimitPct: 2, drawdownHaltPct: 10 };

test('settings saved before the sizing change move to the new risk defaults once', () => {
  const s = normalize({ ...OLD, watchlist: ['BTCUSDT'] });
  assert.equal(s.riskPerTradePct, DEFAULT_ENGINE_CFG.riskPerTradePct);
  assert.equal(s.maxPortfolioRiskPct, DEFAULT_ENGINE_CFG.maxPortfolioRiskPct);
  assert.equal(s.maxOpenPositions, DEFAULT_ENGINE_CFG.maxOpenPositions);
  assert.equal(s.dailyLossLimitPct, DEFAULT_ENGINE_CFG.dailyLossLimitPct);
  assert.equal(s.drawdownHaltPct, DEFAULT_ENGINE_CFG.drawdownHaltPct);
  assert.deepEqual(s.watchlist, ['BTCUSDT']);
});

test('risk settings edited after the sizing change stick', () => {
  const s = normalize(normalize({ ...OLD }));
  const edited = normalize({ ...s, riskPerTradePct: 1.25, maxOpenPositions: 3 });
  assert.equal(edited.riskPerTradePct, 1.25);
  assert.equal(edited.maxOpenPositions, 3);
});
