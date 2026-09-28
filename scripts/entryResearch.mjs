// Entry research: which entry rules have an edge on their own?
//
//   node scripts/entryResearch.mjs --months 36
//
// Each rule is scanned over history, per symbol, without overlapping trades
// (a new signal only after the previous one closed). Every signal is traded
// the same simple way - fixed stop, fixed R target, time stop - and costs are
// charged in R. Results are split in time: rules are judged on the train part
// and confirmed on the test part they never saw. Many rules x targets are
// compared, so a single good-looking row proves little; look for rules that
// are positive on train AND test, with a test t-stat near 2 or more.
//
// Flags:
//   --months <n>     history length (default 36)
//   --split <0..1>   share of the window used as train (default 0.6)
//   --symbols A,B    coins (default: the backtest's liquid list)
//   --end <ISO>      window end (default: last UTC midnight)
//   --cost <pct>     round-trip cost % incl. slippage (default 0.3)
//   --no-cache       refetch history instead of reusing benchmarks/.cache
//
// Output: console table + benchmarks/research-<timestamp>/report.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineCfg, PROFILES, TF_MS, BTC_SYMBOL } from '../src/engine/config.js';
import { evaluateSetup } from '../src/engine/setups.js';
import { loadSeries, DEFAULT_SYMBOLS } from './backtest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONTH_MS = 30 * 86_400_000;
export const TARGETS_R = [1, 1.5, 2, 3];

function r2(v) { return Math.round(v * 100) / 100; }
const closeMsOf = (bar, tf) => bar.time * 1000 + TF_MS[tf];

function lastClosedIndex(bars, tf, ms) {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMsOf(bars[mid], tf) <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function rollingMean(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let k = 0; k < values.length; k += 1) {
    sum += values[k];
    if (k >= period) sum -= values[k - period];
    if (k >= period - 1) out[k] = sum / period;
  }
  return out;
}

// Daily features shared by the rules. Everything at index k uses bars <= k only.
function dailyFeatures(daily) {
  const closes = daily.map((b) => b.close);
  const sma200 = rollingMean(closes, 200);
  const ret30 = closes.map((c, k) => (k >= 30 ? c / closes[k - 30] - 1 : null));
  const priorHigh = (n) => daily.map((_, k) => {
    if (k < n) return null;
    let h = -Infinity;
    for (let m = k - n; m < k; m += 1) h = Math.max(h, daily[m].high);
    return h;
  });
  return { sma200, ret30, high20: priorHigh(20), high55: priorHigh(55) };
}

export function buildEnv(series, symbols) {
  const features = {};
  for (const symbol of new Set([...symbols, BTC_SYMBOL])) {
    if (series[symbol]?.['1d']) features[symbol] = dailyFeatures(series[symbol]['1d']);
  }
  // Cross-sectional 30-day momentum rank per daily bar time.
  const rankByTime = new Map();
  for (const symbol of symbols) {
    series[symbol]['1d'].forEach((bar, k) => {
      const r = features[symbol].ret30[k];
      if (r == null) return;
      if (!rankByTime.has(bar.time)) rankByTime.set(bar.time, []);
      rankByTime.get(bar.time).push({ symbol, r });
    });
  }
  const topByTime = new Map();
  for (const [time, rows] of rankByTime) topByTime.set(time, new Set(rows.sort((a, b) => b.r - a.r).slice(0, 3).map((x) => x.symbol)));
  return { series, features, topByTime, cfg: resolveEngineCfg({}) };
}

// BTC's latest closed daily bar at closeMs: above its 200-day average?
function btcRiskOn(env, closeMs) {
  const d = env.series[BTC_SYMBOL]?.['1d'];
  if (!d) return false;
  const j = lastClosedIndex(d, '1d', closeMs);
  const sma = env.features[BTC_SYMBOL].sma200[j];
  return j >= 0 && sma != null && d[j].close > sma;
}

function relStrength(env, symbol, closeMs) {
  const d = env.series[symbol]['1d'];
  const b = env.series[BTC_SYMBOL]?.['1d'];
  if (!b) return false;
  const j = lastClosedIndex(d, '1d', closeMs);
  const jb = lastClosedIndex(b, '1d', closeMs);
  const r = env.features[symbol].ret30[j];
  const rb = env.features[BTC_SYMBOL].ret30[jb];
  return r != null && rb != null && r > rb;
}

function pullbackSignal(env, symbol, i) {
  const profile = PROFILES.swing;
  const trig = env.series[symbol][profile.triggerTf];
  const filt = env.series[symbol][profile.filterTf];
  const closeMs = closeMsOf(trig[i], profile.triggerTf);
  const j = lastClosedIndex(filt, profile.filterTf, closeMs);
  if (j < 0) return null;
  const btcFilt = env.series[BTC_SYMBOL]?.[profile.filterTf];
  const btc = btcFilt ? { filt: btcFilt, j: lastClosedIndex(btcFilt, profile.filterTf, closeMs) } : null;
  const { signal } = evaluateSetup({ trig, i, filt, j, profile, cfg: env.cfg, btc });
  return signal ? { entry: signal.entryPrice, stop: signal.stopPrice } : null;
}

function atrStop(bar, mult = 2) {
  if (!(bar.atr14 > 0)) return null;
  return { entry: bar.close, stop: bar.close - mult * bar.atr14 };
}

function breakout(env, symbol, i, key) {
  const d = env.series[symbol]['1d'];
  const level = env.features[symbol][key][i];
  return level != null && d[i].close > level ? atrStop(d[i]) : null;
}

// Each rule: { name, tf, maxBars, signal(env, symbol, i) -> { entry, stop } | null }.
export const RULES = [
  { name: 'pullback (current, 4h)', tf: '4h', maxBars: 54, signal: (env, s, i) => pullbackSignal(env, s, i) },
  {
    name: 'pullback + BTC > 200d avg', tf: '4h', maxBars: 54,
    signal: (env, s, i) => (btcRiskOn(env, closeMsOf(env.series[s]['4h'][i], '4h')) ? pullbackSignal(env, s, i) : null)
  },
  {
    name: 'pullback + stronger than BTC (30d)', tf: '4h', maxBars: 54,
    signal: (env, s, i) => (relStrength(env, s, closeMsOf(env.series[s]['4h'][i], '4h')) ? pullbackSignal(env, s, i) : null)
  },
  {
    name: 'pullback + daily ADX >= 25', tf: '4h', maxBars: 54,
    signal: (env, s, i) => {
      const d = env.series[s]['1d'];
      const j = lastClosedIndex(d, '1d', closeMsOf(env.series[s]['4h'][i], '4h'));
      return j >= 0 && d[j].adx14 >= 25 ? pullbackSignal(env, s, i) : null;
    }
  },
  { name: '20-day breakout', tf: '1d', maxBars: 30, signal: (env, s, i) => breakout(env, s, i, 'high20') },
  {
    name: '20-day breakout + BTC > 200d avg', tf: '1d', maxBars: 30,
    signal: (env, s, i) => (btcRiskOn(env, closeMsOf(env.series[s]['1d'][i], '1d')) ? breakout(env, s, i, 'high20') : null)
  },
  {
    name: '55-day breakout + BTC > 200d avg', tf: '1d', maxBars: 30,
    signal: (env, s, i) => (btcRiskOn(env, closeMsOf(env.series[s]['1d'][i], '1d')) ? breakout(env, s, i, 'high55') : null)
  },
  {
    name: 'new top-3 30d momentum + BTC > 200d avg', tf: '1d', maxBars: 30,
    signal: (env, s, i) => {
      const d = env.series[s]['1d'];
      if (i < 1 || !btcRiskOn(env, closeMsOf(d[i], '1d'))) return null;
      const now = env.topByTime.get(d[i].time);
      const before = env.topByTime.get(d[i - 1].time);
      if (!now?.has(s) || before?.has(s) || !(env.features[s].ret30[i] > 0)) return null;
      return atrStop(d[i]);
    }
  }
];

// Trades one signal from the bar after `i`: stop first within a bar (a gap
// below it fills at the open), then the target, then a time exit at the close.
// Returns { r, exitIndex } net of costs, or null if the data ends first.
export function tradeOutcome(bars, i, { entry, stop }, { targetR, maxBars, costPct }) {
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  const target = entry + targetR * risk;
  const costR = (entry * costPct / 100) / risk;
  for (let k = i + 1; k < bars.length && k <= i + maxBars; k += 1) {
    const bar = bars[k];
    let exit = null;
    if (bar.open <= stop) exit = bar.open;
    else if (bar.low <= stop) exit = stop;
    else if (bar.open >= target) exit = bar.open;
    else if (bar.high >= target) exit = target;
    else if (k === i + maxBars) exit = bar.close;
    if (exit != null) return { r: (exit - entry) / risk - costR, exitIndex: k };
  }
  return null;
}

export function stats(rs) {
  const n = rs.length;
  if (!n) return { n: 0, winPct: null, avgR: null, pf: null, t: null };
  const mean = rs.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const gain = rs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const loss = -rs.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  return {
    n, winPct: r2((rs.filter((v) => v > 0).length / n) * 100), avgR: r2(mean),
    pf: loss > 0 ? r2(gain / loss) : null, t: sd > 0 ? r2((mean / sd) * Math.sqrt(n)) : null
  };
}

// Scans one rule over [startMs, endMs) for every symbol and target.
// Returns { [targetR]: [{ symbol, closeMs, r }] }.
export function scanRule(env, rule, symbols, { startMs, endMs, costPct }) {
  const trades = Object.fromEntries(TARGETS_R.map((t) => [t, []]));
  for (const symbol of symbols) {
    const bars = env.series[symbol]?.[rule.tf];
    if (!bars) continue;
    for (const targetR of TARGETS_R) {
      let busyUntil = -1;
      for (let i = 1; i < bars.length; i += 1) {
        const closeMs = closeMsOf(bars[i], rule.tf);
        if (closeMs < startMs || closeMs >= endMs || i <= busyUntil) continue;
        const plan = rule.signal(env, symbol, i);
        if (!plan) continue;
        const outcome = tradeOutcome(bars, i, plan, { targetR, maxBars: rule.maxBars, costPct });
        if (!outcome) continue;
        busyUntil = outcome.exitIndex;
        trades[targetR].push({ symbol, closeMs, r: outcome.r });
      }
    }
  }
  return trades;
}

export function research(series, { symbols, startMs, endMs, splitMs, costPct }) {
  const env = buildEnv(series, symbols);
  return RULES.map((rule) => {
    const byTarget = scanRule(env, rule, symbols, { startMs, endMs, costPct });
    const rows = TARGETS_R.map((targetR) => {
      const all = byTarget[targetR];
      return {
        targetR,
        train: stats(all.filter((t) => t.closeMs < splitMs).map((t) => t.r)),
        test: stats(all.filter((t) => t.closeMs >= splitMs).map((t) => t.r))
      };
    });
    return { rule: rule.name, tf: rule.tf, rows };
  });
}

function parseArgs(argv) {
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const args = { months: 36, split: 0.6, symbols: DEFAULT_SYMBOLS, end, cost: 0.3, cache: true };
  for (let k = 0; k < argv.length; k += 1) {
    const flag = argv[k];
    const value = argv[k + 1];
    if (flag === '--months') { args.months = Number(value); k += 1; }
    else if (flag === '--split') { args.split = Number(value); k += 1; }
    else if (flag === '--symbols') { args.symbols = value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); k += 1; }
    else if (flag === '--end') { args.end = Date.parse(value); k += 1; }
    else if (flag === '--cost') { args.cost = Number(value); k += 1; }
    else if (flag === '--no-cache') args.cache = false;
  }
  return args;
}

const fmt = (s) => (s.n ? `n ${String(s.n).padStart(4)}  win ${String(s.winPct).padStart(5)}%  avg ${String(s.avgR).padStart(5)}R  PF ${String(s.pf ?? '-').padStart(4)}  t ${String(s.t ?? '-').padStart(5)}` : 'no trades');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const splitMs = startMs + args.split * (args.end - startMs);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Loading ${args.symbols.length} symbols, ${args.months} months (${day(startMs)} -> ${day(args.end)})...`);
  const series = await loadSeries({ symbols: args.symbols, startMs, endMs: args.end, useCache: args.cache, log: (m) => console.log(m) });

  const results = research(series, { symbols: args.symbols, startMs, endMs: args.end, splitMs, costPct: args.cost });
  console.log(`\nTrain ${day(startMs)} -> ${day(splitMs)}, test ${day(splitMs)} -> ${day(args.end)}, ${args.cost}% round-trip cost charged in R.`);
  const holdsUp = [];
  for (const r of results) {
    console.log(`\n${r.rule} (${r.tf})`);
    for (const row of r.rows) {
      console.log(`  +${String(row.targetR).padEnd(3)}R target  train: ${fmt(row.train)}   test: ${fmt(row.test)}`);
      if (row.train.avgR > 0 && row.test.avgR > 0 && row.test.n >= 30) holdsUp.push({ rule: r.rule, targetR: row.targetR, test: row.test });
    }
  }
  console.log('\nPositive on both train and test (>= 30 test trades):');
  if (!holdsUp.length) console.log('  none');
  for (const h of holdsUp.sort((a, b) => (b.test.t ?? 0) - (a.test.t ?? 0))) console.log(`  ${h.rule}, +${h.targetR}R: test ${fmt(h.test)}`);

  const outDir = path.join(ROOT, 'benchmarks', `research-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), args: { ...args, end: day(args.end) }, splitAt: day(splitMs), results, holdsUp }, null, 2));
  console.log(`\nReport written to ${path.relative(ROOT, outDir)}/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
