// Coin-list research: which coins should the robot watch?
//
//   node scripts/coinListResearch.mjs --screen            # stage 1, daily data only, fast
//   node scripts/coinListResearch.mjs --compare A,B,C     # stage 2, full engine, slow
//
// Stage 1 (--screen) ranks Binance's most traded USDT pairs by liquidity and
// how well each coin fits the live breakout rules on its own, with no capital
// limits: daily close above the 55-day high (or 20-day), BTC above its
// 200-day average, 3-ATR stop, +3R (55d) / +1R (20d) target, 30-day time
// stop. Daily bars only; if a bar touches both stop and target, the stop is
// assumed first (conservative). Results are split into period A (first 24
// months) and period B (last 12 months) so a list picked on A can be checked
// on B.
//
// Stage 2 (--compare) runs the real engine (advance() + autopilot, 5m exits)
// on each named list over the same window - the same simulate() that
// scripts/backtest.mjs uses - for the full window and A/B separately.
// Lists: "current" (the old 15-coin research list), "live" (DEFAULT_WATCHLIST), "default5" (the app's built-in
// default watchlist), "proposed" (--proposed A,B,...), or any comma list.
//
// Flags: --months 36 (default), --a 24 (months in period A), --top 50 (pairs
// screened), --end ISO, --cost 0.2, --slip 0.05, --out <dir>.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKlinesRange } from '../src/engine/candles.js';
import { enrichCandles } from '../src/indicators.js';
import { resolveEngineCfg } from '../src/engine/config.js';
import { loadSeries, simulate } from './backtest.mjs';
import { DEFAULT_WATCHLIST } from '../src/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://data-api.binance.vision';
const DAY = 86_400_000;
const MONTH = 30 * DAY;
const DEFAULT5 = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
// The 15-coin research list used before the 2026-11-15 refresh.
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'TRXUSDT', 'APTUSDT', 'LTCUSDT', 'NEARUSDT', 'ATOMUSDT', 'INJUSDT', 'TONUSDT'];

// Not tradeable trend assets: stablecoins, fiat, wrapped/staked copies, gold.
const NOT_COINS = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'EUR', 'EURI', 'AEUR', 'USDE', 'XUSD', 'RLUSD', 'USD1', 'BFUSD', 'PYUSD', 'USTC',
  'WBTC', 'WBETH', 'BETH', 'STETH', 'PAXG', 'XAUT', 'GBP', 'TRY', 'BRL', 'ARS', 'JPY', 'ZAR', 'UAH', 'PLN', 'RON', 'MXN', 'COP', 'IDR', 'NGN', 'USDS', 'FRAX', 'GUSD', 'BNSOL']);
const EXCLUDED = new Set(['LSKUSDT', 'VTHOUSDT', 'ASTRUSDT']);

const RULES = [
  { key: 'b55', lookback: 55, stopAtr: 3, targetR: 3, maxBars: 30 },
  { key: 'b20', lookback: 20, stopAtr: 3, targetR: 1, maxBars: 30 }
];

function parseArgs(argv) {
  const end = Math.floor(Date.now() / DAY) * DAY;
  const args = { months: 36, a: 24, top: 50, end, cost: 0.2, slip: 0.05, out: path.join(ROOT, 'reports'), screen: false, compare: null, proposed: [] };
  for (let k = 0; k < argv.length; k += 1) {
    const f = argv[k];
    const v = argv[k + 1];
    if (f === '--screen') args.screen = true;
    else if (f === '--compare') { args.compare = v.split(','); k += 1; }
    else if (f === '--proposed') { args.proposed = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); k += 1; }
    else if (f === '--months') { args.months = Number(v); k += 1; }
    else if (f === '--a') { args.a = Number(v); k += 1; }
    else if (f === '--top') { args.top = Number(v); k += 1; }
    else if (f === '--end') { args.end = Date.parse(v); k += 1; }
    else if (f === '--cost') { args.cost = Number(v); k += 1; }
    else if (f === '--slip') { args.slip = Number(v); k += 1; }
    else if (f === '--out') { args.out = path.resolve(v); k += 1; }
  }
  return args;
}

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function getJson(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function sma(values, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k += 1) s += values[k];
  return s / n;
}

// One rule on one coin, one trade at a time. Returns closed trades with R net of cost.
function runRule(daily, btcAbove, rule, startMs, endMs, costPct) {
  const trades = [];
  let i = rule.lookback;
  while (i < daily.length) {
    const bar = daily[i];
    const closeMs = bar.time * 1000 + DAY;
    if (closeMs < startMs || !(bar.atr14 > 0) || !btcAbove(bar.time)) { i += 1; continue; }
    if (closeMs >= endMs) break;
    let prior = -Infinity;
    for (let k = i - rule.lookback; k < i; k += 1) prior = Math.max(prior, daily[k].high);
    if (!(bar.close > prior)) { i += 1; continue; }
    const entry = bar.close;
    const risk = rule.stopAtr * bar.atr14;
    const stop = entry - risk;
    const target = entry + rule.targetR * risk;
    let exitR = null;
    let j = i + 1;
    for (; j < daily.length && j <= i + rule.maxBars; j += 1) {
      const d = daily[j];
      if (d.time * 1000 + DAY > endMs) break;
      if (d.open <= stop) { exitR = (d.open - entry) / risk; break; }
      if (d.low <= stop) { exitR = -1; break; }
      if (d.open >= target) { exitR = (d.open - entry) / risk; break; }
      if (d.high >= target) { exitR = rule.targetR; break; }
    }
    if (exitR == null) {
      if (j > i + rule.maxBars) exitR = (daily[i + rule.maxBars].close - entry) / risk; // time stop
      else break; // still open at the window end: not counted
    }
    trades.push({ date: bar.date, r: exitR - (costPct / 100) * entry / risk });
    i = j + 1;
  }
  return trades;
}

function summarize(trades) {
  const n = trades.length;
  const total = trades.reduce((s, t) => s + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;
  return { trades: n, winPct: n ? r2((wins / n) * 100) : null, avgR: n ? r2(total / n) : null, totalR: r2(total) };
}

async function screen(args) {
  const startMs = args.end - args.months * MONTH;
  const splitMs = startMs + args.a * MONTH;
  const warmStart = startMs - 260 * DAY;
  const tickers = await getJson(`${BASE_URL}/api/v3/ticker/24hr`);
  const info = await getJson(`${BASE_URL}/api/v3/exchangeInfo?permissions=SPOT`).catch(() => null);
  const trading = info ? new Set(info.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol)) : null;
  const pairs = tickers
    .filter((t) => t.symbol.endsWith('USDT') && (!trading || trading.has(t.symbol)))
    .filter((t) => !NOT_COINS.has(t.symbol.slice(0, -4)) && !EXCLUDED.has(t.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, args.top)
    .map((t) => t.symbol);
  const universe = [...new Set(['BTCUSDT', ...pairs, ...DEFAULT_SYMBOLS])];
  console.log(`Screening ${universe.length} pairs, ${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(args.end).toISOString().slice(0, 10)}, A ends ${new Date(splitMs).toISOString().slice(0, 10)}`);

  const dailyBy = {};
  for (const symbol of universe) {
    try {
      dailyBy[symbol] = enrichCandles(await fetchKlinesRange(BASE_URL, symbol, '1d', warmStart, args.end));
      process.stdout.write('.');
    } catch (error) {
      console.log(`\n  ${symbol}: ${error.message}`);
    }
  }
  console.log('');
  const btc = dailyBy.BTCUSDT;
  const btcCloses = btc.map((b) => b.close);
  const btcGate = new Map(btc.map((b, i) => [b.time, (sma(btcCloses, 200, i) ?? Infinity) < b.close]));
  const btcAbove = (time) => btcGate.get(time) === true;

  const rows = [];
  for (const symbol of universe) {
    const daily = dailyBy[symbol];
    if (!daily?.length) { rows.push({ symbol, error: 'no data' }); continue; }
    const first = daily[0].time * 1000;
    const lastBar = daily.at(-1);
    const fresh = lastBar.time * 1000 + DAY >= args.end - 2 * DAY;
    const fullHistory = first <= startMs - 60 * DAY;
    const last30 = daily.slice(-30);
    const medVol30 = median(last30.map((b) => b.volume * b.close));
    const medVol365 = median(daily.slice(-365).map((b) => b.volume * b.close));
    const atrPct = median(daily.slice(-90).map((b) => b.atrPct).filter(Number.isFinite));
    const byRule = {};
    for (const rule of RULES) {
      byRule[rule.key] = {
        A: summarize(runRule(daily, btcAbove, rule, startMs, splitMs, args.cost + 2 * args.slip)),
        B: summarize(runRule(daily, btcAbove, rule, splitMs, args.end, args.cost + 2 * args.slip)),
        all: summarize(runRule(daily, btcAbove, rule, startMs, args.end, args.cost + 2 * args.slip))
      };
    }
    rows.push({
      symbol, inCurrent: DEFAULT_SYMBOLS.includes(symbol), listedSince: new Date(first).toISOString().slice(0, 10),
      lastBar: lastBar.date, fresh, fullHistory, medVol30M: r2(medVol30 / 1e6), medVol365M: r2(medVol365 / 1e6), atrPct: r2(atrPct), ...byRule
    });
  }
  rows.sort((a, b) => (b.b55?.A.totalR ?? -99) - (a.b55?.A.totalR ?? -99));

  const lines = [
    `# Coin screen ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Window ${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(args.end).toISOString().slice(0, 10)}; A = first ${args.a} months, B = rest. Cost ${args.cost}% + ${args.slip}% slippage per fill, charged in R. Sorted by 55d total R in A.`,
    '',
    '| Coin | Now? | Since | Last bar | 30d med vol $M | 1y med vol $M | ATR% | 55d A n/avg/total | 55d B n/avg/total | 20d A n/avg/total | 20d B n/avg/total |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  ];
  const fmt = (s) => `${s.trades} / ${s.avgR ?? '-'} / ${s.totalR}`;
  for (const r of rows) {
    if (r.error) { lines.push(`| ${r.symbol} | ${r.inCurrent ? 'yes' : ''} | ${r.error} |||||||||`); continue; }
    lines.push(`| ${r.symbol}${r.fullHistory ? '' : ' (short)'}${r.fresh ? '' : ' (STALE)'} | ${r.inCurrent ? 'yes' : ''} | ${r.listedSince} | ${r.lastBar} | ${r.medVol30M} | ${r.medVol365M} | ${r.atrPct} | ${fmt(r.b55.A)} | ${fmt(r.b55.B)} | ${fmt(r.b20.A)} | ${fmt(r.b20.B)} |`);
  }
  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, 'coin-screen.json'), JSON.stringify({ args: { ...args, end: new Date(args.end).toISOString() }, rows }, null, 2));
  await fs.writeFile(path.join(args.out, 'coin-screen.md'), lines.join('\n'));
  console.log(lines.join('\n'));
}

async function compare(args) {
  const startMs = args.end - args.months * MONTH;
  const splitMs = startMs + args.a * MONTH;
  const lists = args.compare.map((name) => {
    if (name === 'current') return { name, symbols: DEFAULT_SYMBOLS };
    if (name === 'current14') return { name, symbols: DEFAULT_SYMBOLS.filter((s) => s !== 'TONUSDT') };
    if (name === 'default5') return { name, symbols: DEFAULT5 };
    if (name === 'proposed') return { name, symbols: args.proposed };
    if (name === 'live') return { name, symbols: DEFAULT_WATCHLIST };
    return { name, symbols: name.split('+').map((s) => s.toUpperCase()) };
  });
  const all = [...new Set(lists.flatMap((l) => l.symbols))];
  console.log(`Loading ${all.length} symbols (all timeframes, cached in benchmarks/.cache)...`);
  const series = await loadSeries({ symbols: all, startMs, endMs: args.end, useCache: true, log: (m) => console.log(m) });
  // A coin with no history in part of the window simply never signals there.
  const cfg = resolveEngineCfg({ roundTripCostPct: args.cost, slippagePct: args.slip });
  const out = [];
  for (const list of lists) {
    const symbols = list.symbols.filter((s) => series[s]?.['1d']?.length);
    const row = { name: list.name, symbols };
    for (const [label, s, e] of [['all', startMs, args.end], ['A', startMs, splitMs], ['B', splitMs, args.end]]) {
      const m = simulate(series, { symbols, startMs: s, endMs: e, cfg, autopilot: true }).metrics;
      row[label] = { trades: m.closedTrades, winRate: m.winRate, pf: m.profitFactor, expR: m.expectancyR, returnPct: m.totalReturnPct, maxDD: m.maxDrawdownPct, open: m.openAtEnd.length, expInclOpen: m.expectancyRInclOpen, maxSymbolShare: m.maxSymbolProfitShare, bySymbol: m.bySymbol };
    }
    const stress = simulate(series, { symbols, startMs, endMs: args.end, cfg: resolveEngineCfg({ roundTripCostPct: 0.3, slippagePct: args.slip }), autopilot: true }).metrics;
    row.stress03 = { returnPct: stress.totalReturnPct, expR: stress.expectancyR, maxDD: stress.maxDrawdownPct };
    out.push(row);
    const f = (m) => `${m.trades} trades, win ${m.winRate}%, PF ${m.pf}, exp ${m.expR}R, ret ${m.returnPct}%, DD ${m.maxDD}%`;
    console.log(`\n${list.name} (${symbols.length}): ${symbols.join(',')}`);
    console.log(`  all: ${f(row.all)} | 0.3% cost: ret ${row.stress03.returnPct}%, DD ${row.stress03.maxDD}%`);
    console.log(`  A:   ${f(row.A)}`);
    console.log(`  B:   ${f(row.B)}`);
    console.log(`  by coin (all): ${Object.entries(row.all.bySymbol).map(([k, v]) => `${k.replace('USDT', '')} ${v.trades}/${Math.round(v.pnlIdr / 1000)}k`).join(', ')}`);
  }
  await fs.mkdir(args.out, { recursive: true });
  await fs.writeFile(path.join(args.out, 'coin-compare.json'), JSON.stringify({ args: { ...args, end: new Date(args.end).toISOString() }, lists: out }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.screen) await screen(args);
if (args.compare) await compare(args);
if (!args.screen && !args.compare) console.log('Pass --screen and/or --compare <lists>.');
