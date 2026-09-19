#!/usr/bin/env node
// Crypto Regime Analyzer - rewritten for robocrypto from
// https://github.com/tradermonty/claude-trading-skills (skills/crypto-regime-analyzer,
// Python + CoinGecko/Binance). This is a Node.js port so it runs with no extra
// dependency in this project (just `node`, same as scripts/benchmark.mjs),
// using the same free, keyless public endpoints as the original:
//   CoinGecko  /global, /coins/markets, /coins/{id}/market_chart
//   Binance    fapi.binance.com/fapi/v1/premiumIndex (perp funding)
//              api.binance.com/api/v3/klines (BTC daily closes - reuses the
//              same endpoint scripts/benchmark.mjs already fetches from)
//
// Six weighted components, 0-100 composite (100 = risk-on):
//   1. BTC Trend Structure        25%   (price vs 50/200DMA stack + slope)
//   2. Alt Breadth Participation  20%   (% of top-N alts above 200/50DMA)
//   3. BTC Dominance Regime       15%   (dominance direction x BTC trend)
//   4. Perpetual Funding Regime   15%   (avg 8h funding across majors)
//   5. Drawdown & Volatility      15%   (BTC drawdown from 1y high + vol regime)
//   6. Momentum Thrust / Washout  10%   (% of universe positive over 30d)
//
// This describes market conditions only - no coin picks, no buy/sell signals,
// no execution. It is meant to sit ALONGSIDE src/aiAdvisor.js's recommendMode()
// as a macro overlay, not replace it: recommendMode picks swing/scalp/day-trade
// for one coin; this scores the whole crypto market's risk posture first.
//
// Run:
//   node .claude/skills/crypto-regime-analyzer/scripts/crypto_regime_analyzer.mjs \
//     --output-dir reports/crypto-regime
//
// Options: --top-n <int> (default 20), --cache-dir <path> (default
// .crypto_regime_cache), --input-json <path> (offline snapshot, skip network),
// --quiet.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readSettings } from '../../../../src/settings.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
// data-api.binance.vision (same default as scripts/benchmark.mjs) mirrors
// Binance's public spot market data without the geo-restrictions
// api.binance.com enforces in some countries/networks. DB-backed now (see
// settings.js), not a config.js env var - read once at startup below since
// this is a one-shot CLI run, not a long-lived server.
const BINANCE_SPOT_BASE = (await readSettings().catch(() => null))?.binanceBaseUrl || 'https://data-api.binance.vision';
// No vision-style mirror exists for the futures funding endpoint, so this one
// stays on fapi.binance.com directly and is allowed to fail gracefully - see
// fetchFunding() below and "Known Limitations" in SKILL.md.
const BINANCE_FAPI_BASE = 'https://fapi.binance.com';
const REQUEST_DELAY_MS = 8000;
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 15000;
const HISTORY_DAYS = 365;
const MAX_ABS_FUNDING_RATE = 1;

const STABLECOIN_IDS = new Set(['tether', 'usd-coin', 'dai', 'first-digital-usd', 'ethena-usde', 'usds', 'paypal-usd', 'true-usd', 'frax', 'binance-usd']);
const WRAPPED_OR_STAKED_IDS = new Set(['wrapped-bitcoin', 'wrapped-steth', 'staked-ether', 'weth', 'coinbase-wrapped-btc', 'wrapped-eeth', 'rocket-pool-eth', 'wrapped-beacon-eth', 'susds']);
const NON_CRYPTO_BETA_IDS = new Set(['figure-heloc', 'blackrock-usd-institutional-digital-liquidity-fund']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function mean(values) { return values.reduce((s, v) => s + v, 0) / values.length; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function getJson(url, params = {}, { quiet } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const res = await fetch(u);
    if (res.status !== 429) {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
      return res.json();
    }
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : BACKOFF_BASE_MS * 2 ** attempt;
    if (!quiet) console.log(`  rate limited (429); backing off ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
  }
  throw new Error(`Gave up after ${MAX_RETRIES} retries: ${u}`);
}

// --- cache (mirrors the Python client: one file per UTC-day per dataset) ---
class Cache {
  constructor(dir) { this.dir = dir; }
  async ensure() { await fs.mkdir(this.dir, { recursive: true }); }
  path(name) {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `${day}_${name}.json`);
  }
  async get(name) {
    try { return JSON.parse(await fs.readFile(this.path(name), 'utf8')); }
    catch { return null; }
  }
  async set(name, data) { await fs.writeFile(this.path(name), JSON.stringify(data)); }
}

// --- data client ------------------------------------------------------------
async function fetchUniverse(cache, topN, quiet) {
  const key = `universe_top${topN}`;
  const cached = await cache.get(key);
  if (cached) return cached;
  const excluded = new Set([...STABLECOIN_IDS, ...WRAPPED_OR_STAKED_IDS, ...NON_CRYPTO_BETA_IDS]);
  const perPage = topN + excluded.size;
  const raw = await getJson(`${COINGECKO_BASE}/coins/markets`, { vs_currency: 'usd', order: 'market_cap_desc', per_page: perPage, page: 1, sparkline: 'false' }, { quiet });
  const universe = raw.filter((c) => !excluded.has(c.id)).slice(0, topN).map((c) => ({ id: c.id, symbol: c.symbol.toUpperCase() }));
  await cache.set(key, universe);
  return universe;
}

async function fetchCoinHistory(cache, coinId, quiet) {
  const cached = await cache.get(`hist_${coinId}`);
  if (cached) return cached;
  const raw = await getJson(`${COINGECKO_BASE}/coins/${coinId}/market_chart`, { vs_currency: 'usd', days: HISTORY_DAYS }, { quiet });
  const closes = (raw.prices || []).map((p) => p[1]);
  await cache.set(`hist_${coinId}`, closes);
  await sleep(REQUEST_DELAY_MS);
  return closes;
}

// BTC's own daily closes come straight from Binance spot klines (same source
// scripts/benchmark.mjs uses) instead of CoinGecko - it's the one series this
// project already knows how to fetch reliably, and skips a CoinGecko round trip.
async function fetchBtcDailyCloses(quiet) {
  const days = HISTORY_DAYS + 30;
  const raw = await getJson(`${BINANCE_SPOT_BASE}/api/v3/klines`, { symbol: 'BTCUSDT', interval: '1d', limit: Math.min(1000, days) }, { quiet });
  return raw.map((row) => Number(row[4]));
}

async function fetchDominanceNow(cache, quiet) {
  const cached = await cache.get('dominance_now');
  if (cached !== null && cached !== undefined) return cached;
  const raw = await getJson(`${COINGECKO_BASE}/global`, {}, { quiet });
  const dom = raw.data.market_cap_percentage.btc;
  await cache.set('dominance_now', dom);
  await appendDominanceHistory(cache, dom);
  return dom;
}

function dominanceHistoryPath(cache) { return path.join(cache.dir, 'dominance_history.json'); }

async function appendDominanceHistory(cache, dom) {
  const p = dominanceHistoryPath(cache);
  let history = {};
  try { history = JSON.parse(await fs.readFile(p, 'utf8')); } catch { /* first run */ }
  history[new Date().toISOString().slice(0, 10)] = dom;
  await fs.writeFile(p, JSON.stringify(history, null, 2));
}

async function loadDominanceSeries(cache) {
  let history;
  try { history = JSON.parse(await fs.readFile(dominanceHistoryPath(cache), 'utf8')); } catch { return []; }
  const today = new Date();
  const requiredKeys = [];
  for (let offset = 30; offset >= 0; offset -= 1) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - offset);
    requiredKeys.push(d.toISOString().slice(0, 10));
  }
  if (requiredKeys.some((k) => !(k in history))) return []; // not enough contiguous history yet
  return requiredKeys.map((k) => history[k]);
}

async function fetchFunding(cache, symbols, quiet) {
  const cacheKey = `funding_${symbols.slice().sort().join(',')}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  const funding = {};
  try {
    const raw = await getJson(`${BINANCE_FAPI_BASE}/fapi/v1/premiumIndex`, {}, { quiet });
    const bySymbol = new Map(raw.map((r) => [r.symbol, r]));
    for (const sym of symbols) {
      const perp = `${sym}USDT`;
      if (bySymbol.has(perp)) funding[perp] = Number(bySymbol.get(perp).lastFundingRate);
    }
  } catch (err) {
    if (!quiet) console.log(`  WARN: funding fetch failed (${err.message}); component will be skipped`);
  }
  await cache.set(cacheKey, funding);
  return funding;
}

async function buildSnapshot({ topN, cacheDir, quiet }) {
  const cache = new Cache(cacheDir);
  await cache.ensure();

  if (!quiet) console.log(`Fetching top-${topN} universe from CoinGecko...`);
  const universe = await fetchUniverse(cache, topN, quiet);

  const series = {};
  if (!quiet) console.log('Fetching BTC daily history from Binance...');
  series.BTC = await fetchBtcDailyCloses(quiet);

  for (let i = 0; i < universe.length; i += 1) {
    const coin = universe[i];
    if (coin.symbol === 'BTC') continue; // already have it from Binance
    if (!quiet) console.log(`  [${i + 1}/${universe.length}] history: ${coin.symbol}`);
    try {
      series[coin.symbol] = await fetchCoinHistory(cache, coin.id, quiet);
    } catch (err) {
      if (!quiet) console.log(`  WARN: ${coin.symbol} history failed (${err.message}); skipping coin`);
    }
  }

  if (!quiet) console.log('Fetching BTC dominance...');
  let dominanceSeries = [];
  try {
    await fetchDominanceNow(cache, quiet);
    dominanceSeries = await loadDominanceSeries(cache);
  } catch (err) {
    if (!quiet) console.log(`  WARN: dominance fetch failed (${err.message}); component will be skipped`);
  }

  if (!quiet) console.log('Fetching Binance funding rates...');
  const funding = await fetchFunding(cache, universe.slice(0, 10).map((c) => c.symbol), quiet);

  return { asOf: new Date().toISOString(), series, dominanceSeries, funding };
}

// --- calculators (ported 1:1 from the Python skill's scripts/calculators/) --

function scaledMean(values) { return mean(values); }

function calcBtcTrend(closes) {
  const SLOPE_LOOKBACK = 20;
  const MIN_FULL_HISTORY = 200 + SLOPE_LOOKBACK;
  const CROSS_PROXIMITY_PCT = 0.015;
  if (!closes || closes.length < MIN_FULL_HISTORY) {
    return { score: 50, signal: `NO DATA: Need >= ${MIN_FULL_HISTORY} daily closes for BTC trend structure`, data_available: false };
  }
  const price = closes.at(-1);
  const ma50 = scaledMean(closes.slice(-50));
  const ma200 = scaledMean(closes.slice(-200));
  const ma200Prev = scaledMean(closes.slice(-(200 + SLOPE_LOOKBACK), -SLOPE_LOOKBACK));
  let ma200Direction;
  if (Math.abs(ma200 - ma200Prev) < 1e-9 * Math.max(1, Math.abs(ma200))) ma200Direction = 'flat';
  else ma200Direction = ma200 > ma200Prev ? 'rising' : 'falling';

  let base, structure;
  const flat = Math.abs(price - ma200) < 1e-9 * Math.max(1, ma200) && Math.abs(ma50 - ma200) < 1e-9 * Math.max(1, ma200);
  if (flat) { base = 50; structure = 'FLAT (price = 50DMA = 200DMA)'; }
  else if (price > ma50 && ma50 > ma200) { base = 90; structure = 'BULL STACK (price > 50DMA > 200DMA)'; }
  else if (price > ma200 && price <= ma50 && ma50 > ma200) { base = 65; structure = 'BULL PULLBACK (price between 200DMA and 50DMA)'; }
  else if (price <= ma200 && price <= ma50 && ma50 > ma200) { base = 55; structure = 'STACK INTACT, PRICE BELOW (deep pullback / early break)'; }
  else if (price > ma50 && ma50 <= ma200) { base = 45; structure = 'RECOVERY ATTEMPT (price above 50DMA, stack still bearish)'; }
  else { base = 15; structure = 'BEAR STACK (price < 50DMA < 200DMA)'; }

  const slopeModifier = ma200Direction === 'rising' ? 10 : ma200Direction === 'falling' ? -10 : 0;
  let score = clamp(base + slopeModifier, 0, 100);
  let signal = `${structure}; 200DMA ${ma200Direction}`;
  if (!flat && ma200 > 0 && Math.abs(ma50 - ma200) / ma200 < CROSS_PROXIMITY_PCT) {
    const cross = ma50 <= ma200 && price > ma50 ? 'golden cross' : 'cross';
    signal += `; 50/200DMA within 1.5% (${cross} watch)`;
  }
  return { score, signal, data_available: true, price: round2(price), ma50: round2(ma50), ma200: round2(ma200), ma200_rising: ma200Direction === 'rising', ma200_direction: ma200Direction };
}

function calcAltBreadth(altSeries) {
  const MIN_HISTORY = 200, MIN_UNIVERSE = 5;
  const eligible = {};
  const skipped = [];
  for (const [symbol, closes] of Object.entries(altSeries || {})) {
    if (closes && closes.length >= MIN_HISTORY) eligible[symbol] = closes;
    else skipped.push(symbol);
  }
  const pctAbove = (window) => {
    let above = 0, counted = 0;
    for (const closes of Object.values(eligible)) {
      if (closes.length < window) continue;
      counted += 1;
      if (closes.at(-1) > scaledMean(closes.slice(-window))) above += 1;
    }
    return { pct: counted ? (above / counted) * 100 : 0, counted };
  };
  const { pct: pct200, counted } = pctAbove(MIN_HISTORY);
  if (counted < MIN_UNIVERSE) {
    return { score: 50, signal: `NO DATA: Only ${counted} alts with >= ${MIN_HISTORY}d history (need ${MIN_UNIVERSE})`, data_available: false };
  }
  const { pct: pct50 } = pctAbove(50);
  let score = pct200 >= 80 ? 95 : pct200 >= 65 ? 80 : pct200 >= 50 ? 65 : pct200 >= 35 ? 45 : pct200 >= 20 ? 25 : 10;
  let modifier = '';
  if (pct50 >= pct200 + 15) { score += 5; modifier = '; short-term thrust (50DMA breadth leading)'; }
  else if (pct50 <= pct200 - 15) { score -= 5; modifier = '; short-term breadth rolling over'; }
  score = clamp(score, 0, 100);
  return {
    score, signal: `${pct200.toFixed(0)}% of ${counted} tracked alts above 200DMA (${pct50.toFixed(0)}% above 50DMA)${modifier}`,
    data_available: true, pct_above_200dma: round1(pct200), pct_above_50dma: round1(pct50), universe_size: counted, skipped
  };
}

function calcDominanceRegime(dominanceSeries, btcTrendUp) {
  const TREND_LOOKBACK = 30, HIGH_DOMINANCE = 62.0, LOW_DOMINANCE = 40.0, FLAT_BAND = 0.5;
  if (!dominanceSeries || dominanceSeries.length < TREND_LOOKBACK + 1) {
    return { score: 50, signal: `NO DATA: Need >= ${TREND_LOOKBACK + 1} daily dominance points`, data_available: false };
  }
  const current = dominanceSeries.at(-1);
  const prior = dominanceSeries.at(-(TREND_LOOKBACK + 1));
  const change = current - prior;
  const domDirection = change > FLAT_BAND ? 'rising' : change < -FLAT_BAND ? 'falling' : 'flat';
  let score, regime;
  if (btcTrendUp) {
    if (domDirection === 'falling') { score = 90; regime = 'ALT ROTATION (BTC up, dominance falling)'; }
    else if (domDirection === 'rising') { score = 65; regime = 'BTC-LED (BTC up, dominance rising; alts lagging)'; }
    else { score = 75; regime = 'BTC UP, dominance flat'; }
  } else {
    if (domDirection === 'rising') { score = 30; regime = 'DEFENSIVE (BTC down, dominance rising)'; }
    else if (domDirection === 'falling') { score = 10; regime = 'DE-RISKING (BTC down, dominance falling)'; }
    else { score = 25; regime = 'BTC DOWN, dominance flat'; }
  }
  let modifier = '';
  if (current >= HIGH_DOMINANCE && !btcTrendUp) { score += 5; modifier = '; dominance at washout extreme (contrarian watch)'; }
  else if (current <= LOW_DOMINANCE && btcTrendUp) { score -= 5; modifier = '; dominance at froth extreme (late-cycle caution)'; }
  score = clamp(score, 0, 100);
  return {
    score, signal: `${regime}; dominance ${current.toFixed(1)}% (${change >= 0 ? '+' : ''}${change.toFixed(1)}pts / ${TREND_LOOKBACK}d)${modifier}`,
    data_available: true, dominance_pct: round2(current), dominance_change_30d: round2(change), direction: domDirection
  };
}

function calcFundingRegime(fundingMap) {
  const MIN_SYMBOLS = 2;
  const rates = Object.values(fundingMap || {}).filter((r) => r !== null && r !== undefined);
  const invalid = rates.filter((r) => typeof r !== 'number' || !Number.isFinite(r) || Math.abs(r) > MAX_ABS_FUNDING_RATE);
  if (invalid.length) return { score: 50, signal: 'INVALID DATA: funding rate must be finite and between -1 and 1', data_available: false };
  if (rates.length < MIN_SYMBOLS) return { score: 50, signal: `NO DATA: Need funding for >= ${MIN_SYMBOLS} symbols`, data_available: false };
  const avg = scaledMean(rates);
  let score, label;
  if (avg <= -0.0001) { score = 80; label = 'WASHED OUT (negative funding; shorts paying longs)'; }
  else if (avg < 0) { score = 65; label = 'SKEPTICAL (mildly negative funding)'; }
  else if (avg <= 0.0001) { score = 75; label = 'NEUTRAL (funding near baseline)'; }
  else if (avg <= 0.0003) { score = 55; label = 'WARMING (long leverage building)'; }
  else if (avg <= 0.0006) { score = 30; label = 'CROWDED (hot funding; crowded longs)'; }
  else { score = 10; label = 'EUPHORIC (extreme funding; cascade risk)'; }
  const annualized = avg * 3 * 365 * 100;
  return {
    score, signal: `${label}; avg ${(avg * 100).toFixed(4)}%/8h (~${annualized.toFixed(1)}% annualized) across ${rates.length} perps`,
    data_available: true, avg_funding_8h: avg, annualized_pct: round2(annualized), n_symbols: rates.length
  };
}

function realizedVol(closes, window) {
  const rets = [];
  for (let i = closes.length - window + 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i]) - Math.log(closes[i - 1]));
  }
  if (rets.length < 2) return 0;
  const m = mean(rets);
  const variance = rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance)) * Math.sqrt(365);
}

function calcDrawdownVol(closes) {
  const MIN_HISTORY = 365, VOL_WINDOW = 30;
  if (!closes || closes.length < MIN_HISTORY) return { score: 50, signal: `NO DATA: Need >= ${MIN_HISTORY} daily closes`, data_available: false };
  const window = closes.slice(-MIN_HISTORY);
  const high = Math.max(...window);
  const price = window.at(-1);
  const dd = high > 0 ? 1 - price / high : 0;
  let score = dd <= 0.10 ? 90 : dd <= 0.20 ? 75 : dd <= 0.35 ? 55 : dd <= 0.50 ? 35 : dd <= 0.65 ? 20 : 10;
  const vols = [];
  for (let i = VOL_WINDOW; i < window.length; i += 7) vols.push(realizedVol(window.slice(0, i + 1), VOL_WINDOW));
  const currentVol = realizedVol(window, VOL_WINDOW);
  const below = vols.filter((v) => v <= currentVol).length;
  const volPctile = vols.length ? below / vols.length : 0.5;
  let modifier = '';
  if (volPctile <= 1 / 3) { score += 10; modifier = '; volatility compressed (bottom third of 1y range)'; }
  else if (volPctile >= 2 / 3) { score -= 10; modifier = '; volatility elevated (top third of 1y range)'; }
  if (dd > 0.65 && volPctile >= 2 / 3) { score = Math.max(score, 15); modifier += '; capitulation-zone contrarian floor applied'; }
  score = clamp(score, 0, 100);
  return {
    score, signal: `Drawdown ${(dd * 100).toFixed(1)}% from 1y high${modifier}`,
    data_available: true, drawdown_pct: round2(dd * 100), realized_vol_30d: round4(currentVol), vol_percentile_1y: round2(volPctile)
  };
}

function calcMomentumThrust(seriesMap) {
  const LOOKBACK = 30, MIN_UNIVERSE = 5;
  let positive = 0, counted = 0;
  for (const closes of Object.values(seriesMap || {})) {
    if (!closes || closes.length < LOOKBACK + 1) continue;
    counted += 1;
    if (closes.at(-1) > closes.at(-(LOOKBACK + 1))) positive += 1;
  }
  if (counted < MIN_UNIVERSE) return { score: 50, signal: `NO DATA: Only ${counted} coins with >= ${LOOKBACK + 1}d history`, data_available: false };
  const pct = (positive / counted) * 100;
  let score, label;
  if (pct >= 85) { score = 90; label = 'BROAD THRUST'; }
  else if (pct >= 65) { score = 75; label = 'POSITIVE'; }
  else if (pct >= 45) { score = 55; label = 'MIXED'; }
  else if (pct >= 25) { score = 35; label = 'WEAK'; }
  else if (pct >= 10) { score = 20; label = 'BROADLY NEGATIVE'; }
  else { score = 35; label = 'WASHOUT (contrarian: near-total negative momentum)'; }
  return { score, signal: `${label}: ${pct.toFixed(0)}% of ${counted} coins positive over ${LOOKBACK}d`, data_available: true, pct_positive_30d: round1(pct), universe_size: counted };
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// --- scorer (1:1 port of scorer.py) -----------------------------------------
const COMPONENT_WEIGHTS = { btc_trend: 0.25, alt_breadth: 0.20, dominance: 0.15, funding: 0.15, drawdown_vol: 0.15, momentum_thrust: 0.10 };
const MIN_AVAILABLE_COMPONENTS = 4;
const MIN_AVAILABLE_WEIGHT = 0.65;
const ZONES = [
  [80, 'RISK_ON', 'Broad risk-on conditions observed; review risk limits before decisions'],
  [40, 'NEUTRAL', 'Mixed conditions observed; no strong regime conclusion'],
  [0, 'RISK_OFF', 'Defensive market conditions observed; review existing risk controls']
];

function calculateComposite(components) {
  const available = Object.fromEntries(Object.entries(components).filter(([cid, c]) => cid in COMPONENT_WEIGHTS && c.data_available));
  const totalWeight = Object.keys(available).reduce((s, cid) => s + COMPONENT_WEIGHTS[cid], 0);
  const nAvailable = Object.keys(available).length;
  if (nAvailable < MIN_AVAILABLE_COMPONENTS || totalWeight < MIN_AVAILABLE_WEIGHT) {
    return {
      score: null, zone: 'UNKNOWN',
      guidance: `Insufficient component coverage for a regime classification (${nAvailable}/${Object.keys(COMPONENT_WEIGHTS).length} components, ${Math.round(totalWeight * 100)}% model weight)`,
      effective_weights: {}, components_available: nAvailable, components_total: Object.keys(COMPONENT_WEIGHTS).length, available_weight: round4(totalWeight)
    };
  }
  const effective = Object.fromEntries(Object.entries(available).map(([cid]) => [cid, COMPONENT_WEIGHTS[cid] / totalWeight]));
  let score = Object.entries(effective).reduce((s, [cid, w]) => s + available[cid].score * w, 0);
  score = round1(clamp(score, 0, 100));
  let [, zone, guidance] = ZONES.at(-1);
  for (const [threshold, z, g] of ZONES) { if (score >= threshold) { zone = z; guidance = g; break; } }
  return { score, zone, guidance, effective_weights: Object.fromEntries(Object.entries(effective).map(([k, v]) => [k, round4(v)])), components_available: nAvailable, components_total: Object.keys(COMPONENT_WEIGHTS).length, available_weight: round4(totalWeight) };
}

// --- report ------------------------------------------------------------------
function buildReport(snapshot) {
  const btcSeries = snapshot.series.BTC || [];
  const altSeries = Object.fromEntries(Object.entries(snapshot.series).filter(([sym]) => sym !== 'BTC'));

  const btcTrend = calcBtcTrend(btcSeries);
  const altBreadth = calcAltBreadth(altSeries);
  const dominance = calcDominanceRegime(snapshot.dominanceSeries, btcTrend.ma200_rising ?? (btcTrend.score >= 50));
  const funding = calcFundingRegime(snapshot.funding);
  const drawdownVol = calcDrawdownVol(btcSeries);
  const momentumThrust = calcMomentumThrust(snapshot.series);

  const components = { btc_trend: btcTrend, alt_breadth: altBreadth, dominance, funding, drawdown_vol: drawdownVol, momentum_thrust: momentumThrust };
  const composite = calculateComposite(components);
  return { metadata: { as_of: snapshot.asOf, generated_at: new Date().toISOString() }, components, composite };
}

function toMarkdown(report) {
  const { composite, components, metadata } = report;
  const labels = { btc_trend: 'BTC Trend Structure', alt_breadth: 'Alt Breadth Participation', dominance: 'BTC Dominance Regime', funding: 'Perpetual Funding Regime', drawdown_vol: 'Drawdown & Volatility Position', momentum_thrust: 'Momentum Thrust / Washout' };
  const lines = [
    '# Crypto Regime Report', '',
    `**As of**: ${metadata.as_of}`, '',
    `## ${composite.zone} (score ${composite.score ?? 'n/a'}/100)`, '',
    composite.guidance, '',
    '## Components', '',
    '| Component | Weight | Score | Signal |', '|---|---:|---:|---|'
  ];
  for (const [cid, label] of Object.entries(labels)) {
    const c = components[cid];
    const weight = COMPONENT_WEIGHTS[cid];
    lines.push(`| ${label} | ${Math.round(weight * 100)}% | ${c.data_available ? c.score : 'n/a'} | ${c.signal} |`);
  }
  lines.push('', '_Educational and process-improvement use only - describes market conditions, not financial advice or a trade signal._', '');
  return lines.join('\n');
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { topN: 20, cacheDir: '.crypto_regime_cache', outputDir: 'reports/crypto-regime', inputJson: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--top-n') opts.topN = Number(argv[++i]);
    else if (a === '--cache-dir') opts.cacheDir = argv[++i];
    else if (a === '--output-dir') opts.outputDir = argv[++i];
    else if (a === '--input-json') opts.inputJson = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let snapshot;
  if (opts.inputJson) {
    const raw = JSON.parse(await fs.readFile(opts.inputJson, 'utf8'));
    snapshot = { asOf: raw.as_of || new Date().toISOString(), series: raw.series, dominanceSeries: raw.dominance_series || [], funding: raw.funding || {} };
  } else {
    snapshot = await buildSnapshot({ topN: opts.topN, cacheDir: opts.cacheDir, quiet: opts.quiet });
  }

  const report = buildReport(snapshot);
  await fs.mkdir(opts.outputDir, { recursive: true });
  await fs.writeFile(path.join(opts.outputDir, 'crypto_regime.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(opts.outputDir, 'crypto_regime.md'), toMarkdown(report));

  const { composite } = report;
  console.log(`\nCRYPTO REGIME: ${composite.zone} (score ${composite.score ?? 'n/a'}/100) - ${composite.guidance}`);
  for (const [cid, c] of Object.entries(report.components)) {
    if (!c.data_available) console.log(`  (skipped: ${cid} - ${c.signal})`);
  }
  console.log(`\nFull report written to ${opts.outputDir}/`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('\ncrypto_regime_analyzer failed:', err.message);
    process.exitCode = 1;
  });
}

export { calcBtcTrend, calcAltBreadth, calcDominanceRegime, calcFundingRegime, calcDrawdownVol, calcMomentumThrust, calculateComposite, buildReport };
