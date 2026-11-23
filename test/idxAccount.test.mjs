import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYahooDaily, idxEngineCfg, loadIdxSeries, normalizeIdxSymbol } from '../src/markets/idx.js';
import { bookView, accountSnapshot, positionsOf } from '../src/account.js';
import { createPortfolio, openPositionQty, sellPosition } from '../src/engine/ledger.js';
import { sizePosition, bookEquityIdr } from '../src/engine/sizing.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { preTradeCheck, rewardRisk } from '../src/engine/preTradeCheck.js';
import { resolveEngineCfg, profilesFor } from '../src/engine/config.js';
import { idxPass } from '../src/engine/idxPass.js';
import { mulberry32 } from './helpers.mjs';

// Fake Yahoo chart JSON: one bar per weekday at 09:00 WIB (02:00 UTC), as Yahoo sends for .JK.
function yahooJson({ days, startMs, startPrice, drift, seed, volume = 50_000_000, spikeAt = null }) {
  const rand = mulberry32(seed);
  const ts = []; const o = []; const h = []; const l = []; const c = []; const v = [];
  let p = startPrice;
  let t = startMs;
  for (let n = 0; ts.length < days; n += 1, t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const open = p;
    let move = drift + (rand() - 0.5) * 0.03;
    if (spikeAt != null && ts.length === spikeAt) move = 0.12;
    const close = Math.max(50, open * (1 + move));
    ts.push(Math.floor(t / 1000) + 2 * 3600);
    o.push(open); c.push(close);
    h.push(Math.max(open, close) * (1 + rand() * 0.01)); l.push(Math.min(open, close) * (1 - rand() * 0.01));
    v.push(volume);
    p = close;
  }
  return { chart: { result: [{ meta: { gmtoffset: 25200, regularMarketPrice: p }, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }] } };
}

test('Yahoo daily candles close at 16:15 WIB on their trading date; gaps dropped', () => {
  const json = yahooJson({ days: 5, startMs: Date.UTC(2026, 10, 2), startPrice: 9000, drift: 0, seed: 1 });
  json.chart.result[0].indicators.quote[0].close[2] = null;
  const { candles, livePrice } = parseYahooDaily(json);
  assert.equal(candles.length, 4);
  assert.equal(candles[0].date, '2026-11-02');
  assert.equal(candles[0].closeTime, Date.UTC(2026, 10, 2, 9, 15));
  assert.equal(candles[0].time * 1000 + 86_400_000, candles[0].closeTime);
  assert.ok(livePrice > 0);
  assert.throws(() => parseYahooDaily({ chart: { result: null, error: { description: 'No data found' } } }), /No data found/);
});

test('IDX tickers are normalized to 4-letter codes', () => {
  assert.equal(normalizeIdxSymbol('bbca.jk'), 'BBCA');
  assert.equal(normalizeIdxSymbol('BTCUSDT'), null);
});

test('loadIdxSeries keeps the forming candle out of the closed series during the session', async () => {
  const json = yahooJson({ days: 260, startMs: Date.UTC(2025, 9, 1), startPrice: 5000, drift: 0.001, seed: 2 });
  const { candles } = parseYahooDaily(json);
  const lastClose = candles.at(-1).closeTime;
  const fetcher = async () => json;
  const during = await loadIdxSeries(['BBCA'], { nowMs: lastClose - 3_600_000, fetcher });
  assert.equal(during.series.BBCA['1d'].length, candles.length - 1);
  const after = await loadIdxSeries(['BBCA'], { nowMs: lastClose + 60_000, fetcher });
  assert.equal(after.series.BBCA['1d'].length, candles.length);
});

test('one cash pool: both books spend the same balance and see each other in equity', () => {
  const pf = createPortfolio(100_000_000);
  const crypto = bookView(pf, 'crypto');
  const idx = bookView(pf, 'idx');
  openPositionQty(crypto, { symbol: 'BTCUSDT', profile: 'breakout', setup: 'breakout', quantity: 0.1, entryPrice: 50_000, stopPrice: 45_000, riskIdr: 800_000, score: 50, reason: '', timeMs: 0, barTime: 0, usdIdrRate: 16_000, roundTripCostPct: 0 });
  openPositionQty(idx, { symbol: 'BBCA', profile: 'idxBreakout', setup: 'breakout', quantity: 1000, entryPrice: 9000, stopPrice: 8500, riskIdr: 500_000, score: 50, reason: '', timeMs: 0, barTime: 0, usdIdrRate: 1, roundTripCostPct: 0 });
  assert.equal(pf.balanceIdr, 100_000_000 - 80_000_000 - 9_000_000);
  assert.equal(Object.keys(pf.positions).join(), 'BTCUSDT');
  assert.equal(Object.keys(positionsOf(pf, 'idx')).join(), 'BBCA');
  // Each book's equity is the whole account at cost.
  assert.equal(bookEquityIdr(crypto), 100_000_000);
  assert.equal(bookEquityIdr(idx), 100_000_000);
  sellPosition(idx, { symbol: 'BBCA', price: 10_000, reason: 'test', exitKind: 'target', timeMs: 1, usdIdrRate: 1, roundTripCostPct: 0 });
  assert.equal(pf.realizedProfitIdr, 1_000_000);
  assert.equal(idx.realizedProfitIdr, 1_000_000);
  assert.equal(crypto.realizedProfitIdr, 0);
  const snap = accountSnapshot(pf, { crypto: { BTCUSDT: 55_000 }, idx: {} }, { crypto: 16_000, idx: 1 });
  assert.equal(snap.markets.crypto.unrealizedProfitIdr, 8_000_000);
  assert.equal(snap.equityIdr, pf.balanceIdr + 88_000_000);
  assert.equal(snap.markets.idx.realizedProfitIdr, 1_000_000);
});

test('IDX sizing buys whole lots of 100 shares', () => {
  const pf = bookView(createPortfolio(50_000_000), 'idx');
  const cfg = idxEngineCfg({ riskPerTradePct: 2, maxPortfolioRiskPct: 10, tradeAllocationPct: 0.3, dailyLossLimitPct: 4, maxConsecutiveLosses: 3, drawdownHaltPct: 25 });
  const sized = sizePosition({ portfolio: pf, entryPrice: 9125, stopPrice: 8700, usdIdrRate: 1, cfg });
  assert.ok(sized.qty > 0);
  assert.equal(sized.qty % 100, 0);
  const tiny = sizePosition({ portfolio: bookView(createPortfolio(200_000), 'idx'), entryPrice: 9125, stopPrice: 8700, usdIdrRate: 1, cfg });
  assert.equal(tiny.qty, 0);
  assert.match(tiny.reason, /lot/);
});

test('pre-trade check: reward:risk, cash buffer and trades per day', () => {
  const cfg = resolveEngineCfg({ roundTripCostPct: 0.4, preTrade: { minRewardRisk: 1, cashBufferPct: 10, maxTradesPerDay: 1 } });
  const profile = profilesFor(cfg).idxBreakout;
  const state = createEngineState();
  const pf = bookView(createPortfolio(10_000_000), 'idx');
  assert.ok(rewardRisk({ entryPrice: 100, stopPrice: 90, targetR: 2, roundTripCostPct: 0.4 }) > 1.8);
  const ok = preTradeCheck({ state, portfolio: pf, cfg, profile, entryPrice: 100, stopPrice: 90, qty: 10_000, riskIdr: 100_000, usdIdrRate: 1, nowMs: 0 });
  assert.equal(ok.ok, true);
  const lowRR = preTradeCheck({ state, portfolio: pf, cfg, profile, entryPrice: 100, stopPrice: 90, targetPrice: 105, qty: 100, riskIdr: 1000, usdIdrRate: 1, nowMs: 0 });
  assert.equal(lowRR.ok, false);
  assert.match(lowRR.reason, /reward:risk/);
  const noCash = preTradeCheck({ state, portfolio: pf, cfg, profile, entryPrice: 100, stopPrice: 90, qty: 95_000, riskIdr: 100_000, usdIdrRate: 1, nowMs: 0 });
  assert.match(noCash.reason, /cash after buy/);
  state.preTrade.trades = 1;
  assert.match(preTradeCheck({ state, portfolio: pf, cfg, profile, entryPrice: 100, stopPrice: 90, qty: 100, riskIdr: 1000, usdIdrRate: 1, nowMs: 0 }).reason, /entries today/);
  // Crypto uses the skill gate by default; preTrade: null turns every limit off.
  const bad = { state: createEngineState(), portfolio: pf, profile, entryPrice: 100, stopPrice: 99.9, targetPrice: 100.01, qty: 1e9, riskIdr: 1e12, usdIdrRate: 1, nowMs: 0 };
  assert.equal(preTradeCheck({ ...bad, cfg: resolveEngineCfg() }).ok, false);
  assert.equal(preTradeCheck({ ...bad, cfg: resolveEngineCfg({ preTrade: null }) }).ok, true);
});

function idxSeriesFrom(jsonBySymbol, nowMs) {
  const out = {};
  return loadIdxSeries(Object.keys(jsonBySymbol), { nowMs, fetcher: async (url) => {
    const sym = Object.keys(jsonBySymbol).find((s) => url.includes(s === 'IHSG' ? '%5EJKSE' : `${s}.JK`));
    return jsonBySymbol[sym];
  } }).then((r) => Object.assign(out, r));
}

test('IDX book trades a breakout through the shared engine with IHSG as the regime filter', async () => {
  const start = Date.UTC(2025, 0, 6);
  const jsons = {
    IHSG: yahooJson({ days: 320, startMs: start, startPrice: 7000, drift: 0.004, seed: 5, volume: 1e9 }),
    BBCA: yahooJson({ days: 320, startMs: start, startPrice: 9000, drift: 0.0015, seed: 6, spikeAt: 319 }),
    BBRI: yahooJson({ days: 320, startMs: start, startPrice: 4000, drift: -0.001, seed: 7 })
  };
  const lastClose = parseYahooDaily(jsons.BBCA).candles.at(-1).closeTime;
  const r = await idxSeriesFrom(jsons, lastClose + 5 * 60_000);
  const settings = { riskPerTradePct: 2, maxPortfolioRiskPct: 10, tradeAllocationPct: 0.3, dailyLossLimitPct: 4, maxConsecutiveLosses: 3, drawdownHaltPct: 25, idx: { maxOpenPositions: 4 } };
  const cfg = idxEngineCfg(settings);
  const account = createPortfolio(100_000_000);
  const book = bookView(account, 'idx');
  const out = advance(createEngineState(), book, r.series, { nowMs: lastClose + 5 * 60_000, live: true, usdIdrRate: 1, cfg, tradeSymbols: ['BBCA', 'BBRI'] });
  const buy = out.transactions.find((t) => t.symbol === 'BBCA');
  assert.ok(buy, `expected a BBCA breakout buy, signals: ${JSON.stringify(out.signals)}`);
  assert.equal(buy.quantity % 100, 0);
  assert.match(buy.reason, /IHSG above its 50-day average/);
  assert.ok(positionsOf(account, 'idx').BBCA);
  assert.deepEqual(account.positions, {});
  assert.ok(account.balanceIdr < 100_000_000);
});

test('idxPass writes the IDX state and cache in the caller\'s transaction and tags fills', async () => {
  const start = Date.UTC(2025, 0, 6);
  const jsons = {
    IHSG: yahooJson({ days: 320, startMs: start, startPrice: 7000, drift: 0.004, seed: 5, volume: 1e9 }),
    BBCA: yahooJson({ days: 320, startMs: start, startPrice: 9000, drift: 0.0015, seed: 6, spikeAt: 319 })
  };
  const lastClose = parseYahooDaily(jsons.BBCA).candles.at(-1).closeTime;
  const loader = (symbols, opts) => loadIdxSeries(symbols, { ...opts, fetcher: async (url) => jsons[Object.keys(jsons).find((s) => url.includes(s === 'IHSG' ? '%5EJKSE' : `${s}.JK`))] });
  const settings = { riskPerTradePct: 2, maxPortfolioRiskPct: 10, tradeAllocationPct: 0.3, dailyLossLimitPct: 4, maxConsecutiveLosses: 3, drawdownHaltPct: 25, idx: { enabled: true, autoTrade: true, watchlist: ['BBCA'], maxOpenPositions: 4 } };
  const account = createPortfolio(100_000_000);
  const res = await idxPass({ settings, portfolio: account, nowMs: lastClose + 60_000, stored: null, loader });
  assert.ok(res.writes['idx-engine-state.json'].lastRunMs);
  assert.ok(res.cache.stocks.BBCA);
  assert.equal(res.cache.stocks.BBCA.stage, 'holding');
  assert.ok(res.cache.ihsg.regimeOk);
  assert.equal(res.out.transactions[0].market, 'idx');
  assert.ok(res.cache.odds.BBCA, 'time-machine odds for the open position');
  // Not due again a minute later; off when disabled.
  assert.equal(await idxPass({ settings, portfolio: account, nowMs: lastClose + 120_000, stored: res.writes['idx-engine-state.json'], loader }), null);
  assert.equal(await idxPass({ settings: { ...settings, idx: { ...settings.idx, enabled: false } }, portfolio: account, nowMs: lastClose, stored: null, loader }), null);
});
