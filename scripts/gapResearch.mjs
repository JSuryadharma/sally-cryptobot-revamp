// Gap-rebound research: after a sharp drop leaves a "gap" (price imbalance)
// on the daily or 4h chart, does buying the lower-timeframe RSI + EMA turn
// back up, with the gap as the target, have an edge?
//
//   node scripts/gapResearch.mjs --months 36
//
// Long only (spot). Every variant is scanned per coin with no overlapping
// trades, traded the same way (structure stop, gap target, time stop) and
// costs are charged in R. Results are split in time: train first, then the
// test part the rules never saw. A "no gap" control row runs the same RSI/EMA
// trigger without any gap, to show whether the gap itself adds anything.
//
// Gap kinds, found on closed bars of the gap timeframe (1d or 4h):
//   fvg   3-candle imbalance: bar k's high is below bar k-2's low. The gap
//         zone is [high k, low k-2]; price has not traded there since.
//   drop  one big red candle: open - close >= 1.5 ATR. Zone = [close, open].
// A gap stays live for 10 days, until price trades back to its top (filled)
// or until one trade was taken from it.
//
// Trigger, on closed bars of the trigger timeframe (1h or 15m), while the
// price is still below the gap: either RSI14 was under 30 in the last 24 bars
// and the close reclaims the EMA20 with RSI above 40 ("reclaim"), or RSI14
// simply closes back above 30 ("rsi").
// Entry = that close. Stop = lowest low of the last 24 bars - 0.5 ATR.
// "Deep" rows keep only big gaps (fvg >= 1 ATR tall, drop candle >= 2.5 ATR).
// Targets (sell): gap middle, gap top (full fill), above the gap (top + 25%
// of the gap height), or a fixed +1.5R.
// Time stop: 7 days. A bar that touches both stop and target counts as a stop.
//
// Flags: --months <n> (36)  --split <0..1> (0.6)  --symbols A,B
//        --end <ISO> (last UTC midnight)  --cost <pct> (0.25)  --no-cache
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TF_MS, BTC_SYMBOL } from '../src/engine/config.js';
import { fetchKlinesRange } from '../src/engine/candles.js';
import { ema, rsi } from '../src/indicators.js';
import { DEFAULT_SYMBOLS } from './backtest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://data-api.binance.vision';
const MONTH_MS = 30 * 86_400_000;
const DAY = 86_400_000;
const TFS = ['1d', '4h', '1h', '15m'];
const WARMUP_DAYS = 220;

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadRaw(symbol, tf, startMs, endMs, useCache) {
  if (!useCache) return fetchKlinesRange(BASE_URL, symbol, tf, startMs, endMs);
  const dir = path.join(ROOT, 'benchmarks', '.cache');
  const file = path.join(dir, `${symbol}_${tf}_${startMs}_${endMs}.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* fetch */ }
  const raw = await fetchKlinesRange(BASE_URL, symbol, tf, startMs, endMs);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw));
  return raw;
}

function atrArr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let k = 1; k < bars.length; k += 1) {
    const tr = Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close));
    if (k < period) { prev = (prev ?? 0) + tr; continue; }
    if (k === period) { prev = (prev + tr) / period; out[k] = prev; continue; }
    prev = (prev * (period - 1) + tr) / period;
    out[k] = prev;
  }
  return out;
}

function smaArr(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let k = 0; k < values.length; k += 1) {
    sum += values[k];
    if (k >= period) sum -= values[k - period];
    if (k >= period - 1) out[k] = sum / period;
  }
  return out;
}

// Compact series: plain arrays, no per-bar objects (15m x 3 years is large).
export function pack(raw, tf) {
  const bars = raw.slice().sort((a, b) => a.time - b.time);
  const close = bars.map((b) => b.close);
  return {
    tf,
    openMs: bars.map((b) => b.time * 1000),
    open: bars.map((b) => b.open), high: bars.map((b) => b.high), low: bars.map((b) => b.low), close,
    ema20: ema(close, 20), ema50: ema(close, 50), rsi14: rsi(close, 14), atr14: atrArr(bars),
    sma200: tf === '1d' ? smaArr(close, 200) : null
  };
}

const closeMs = (s, k) => s.openMs[k] + TF_MS[s.tf];

// Index of the last bar closed at or before ms.
function lastClosed(s, ms) {
  let lo = 0, hi = s.openMs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMs(s, mid) <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// deep: only big gaps - fvg at least 1 ATR tall, drop candle at least 2.5 ATR.
function findGaps(s, kind, deep = false) {
  const gaps = [];
  for (let k = 2; k < s.close.length; k += 1) {
    const atr = s.atr14[k - 1];
    if (!(atr > 0)) continue;
    if (kind === 'fvg') {
      const bottom = s.high[k], top = s.low[k - 2];
      if (top - bottom >= (deep ? 1 : 0.25) * atr && s.close[k] < s.open[k]) gaps.push({ k, bottom, top, formedMs: closeMs(s, k) });
    } else if (s.open[k] - s.close[k] >= (deep ? 2.5 : 1.5) * atr) {
      gaps.push({ k, bottom: s.close[k], top: s.open[k], formedMs: closeMs(s, k) });
    }
  }
  return gaps;
}

function btcRiskOn(btcDaily, ms) {
  const j = lastClosed(btcDaily, ms);
  return j >= 0 && btcDaily.sma200[j] != null && btcDaily.close[j] > btcDaily.sma200[j];
}

// reclaim: RSI14 was under 30 in the last 24 bars, this bar is the first close
//          back above the EMA20 and RSI is back above 40.
// rsi:     RSI14 closes back above 30 after being under it (no EMA check).
export function triggerAt(t, i, { trig }) {
  if (i < 25 || t.rsi14[i] == null || t.ema20[i] == null || t.ema20[i - 1] == null || !(t.atr14[i] > 0)) return false;
  if (trig === 'rsi') return t.rsi14[i] > 30 && t.rsi14[i - 1] <= 30;
  if (!(t.close[i] > t.ema20[i] && t.close[i - 1] <= t.ema20[i - 1] && t.rsi14[i] > 40)) return false;
  for (let m = i - 24; m <= i; m += 1) if (t.rsi14[m] < 30) return true;
  return false;
}

function planAt(t, i) {
  let low = Infinity;
  for (let m = i - 23; m <= i; m += 1) low = Math.min(low, t.low[m]);
  const entry = t.close[i];
  const stop = low - 0.5 * t.atr14[i];
  return entry > stop ? { entry, stop } : null;
}

// Walks forward on the trigger bars. Returns { r, exitIndex, why } net of costs.
function outcome(t, i, { entry, stop, target }, { maxBars, costPct }) {
  const risk = entry - stop;
  const costR = (entry * costPct / 100) / risk;
  const last = Math.min(t.close.length - 1, i + maxBars);
  for (let k = i + 1; k <= last; k += 1) {
    if (t.low[k] <= stop) return { r: (Math.min(stop, t.open[k]) - entry) / risk - costR, exitIndex: k, why: 'stop' };
    if (t.high[k] >= target) return { r: (Math.max(target, t.open[k]) - entry) / risk - costR, exitIndex: k, why: 'target' };
  }
  if (last < i + maxBars) return null; // data ends first
  return { r: (t.close[last] - entry) / risk - costR, exitIndex: last, why: 'time' };
}

const TARGETS = {
  bottom: (g) => g.bottom,
  middle: (g) => (g.bottom + g.top) / 2,
  top: (g) => g.top,
  above: (g) => g.top + 0.25 * (g.top - g.bottom),
  r15: (_g, p) => p.entry + 1.5 * (p.entry - p.stop)
};

function scanVariant(data, v, symbols, { startMs, endMs, costPct, btcDaily }) {
  const trades = [];
  for (const symbol of symbols) {
    const t = data[symbol][v.trigTf];
    const g = data[symbol][v.gapTf];
    if (!t || !g) continue;
    const maxBars = Math.round(7 * DAY / TF_MS[v.trigTf]);
    const liveBars = Math.round(10 * DAY / TF_MS[v.trigTf]);
    let busyUntil = -1;
    const gaps = v.gapKind ? findGaps(g, v.gapKind, v.deep) : null;
    if (gaps) {
      for (const gap of gaps) {
        if (gap.formedMs < startMs || gap.formedMs >= endMs) continue;
        const i0 = lastClosed(t, gap.formedMs) + 1;
        for (let i = Math.max(i0, busyUntil + 1); i < Math.min(t.close.length, i0 + liveBars); i += 1) {
          if (closeMs(t, i) >= endMs) break;
          if (t.high[i] >= gap.top) break; // filled before any trigger
          if (t.close[i] >= gap.bottom) continue; // must still be below the gap
          if (!triggerAt(t, i, v)) continue;
          if (v.btc && !btcRiskOn(btcDaily, closeMs(t, i))) continue;
          const plan = planAt(t, i);
          if (!plan) continue;
          const target = TARGETS[v.target](gap, plan);
          if (!(target > plan.entry)) continue;
          if (v.minRR && (target - plan.entry) / (plan.entry - plan.stop) < v.minRR) continue;
          const res = outcome(t, i, { ...plan, target }, { maxBars, costPct });
          if (!res) break;
          trades.push({ symbol, entryMs: closeMs(t, i), gapMs: gap.formedMs, entry: plan.entry, stop: plan.stop, target, ...res });
          busyUntil = res.exitIndex;
          break; // one trade per gap
        }
      }
    } else {
      // Control: the same trigger with no gap, +1.5R target.
      for (let i = 24; i < t.close.length; i += 1) {
        const ms = closeMs(t, i);
        if (ms < startMs || i <= busyUntil) continue;
        if (ms >= endMs) break;
        if (!triggerAt(t, i, v)) continue;
        if (v.btc && !btcRiskOn(btcDaily, ms)) continue;
        const plan = planAt(t, i);
        if (!plan) continue;
        const res = outcome(t, i, { ...plan, target: TARGETS.r15(null, plan) }, { maxBars, costPct });
        if (!res) break;
        trades.push({ symbol, entryMs: ms, entry: plan.entry, stop: plan.stop, ...res });
        busyUntil = res.exitIndex;
      }
    }
  }
  return trades.sort((a, b) => a.entryMs - b.entryMs);
}

function stats(rs) {
  const n = rs.length;
  if (!n) return { n: 0 };
  const mean = rs.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const win = rs.filter((v) => v > 0);
  const gain = win.reduce((s, v) => s + v, 0);
  const loss = -rs.filter((v) => v <= 0).reduce((s, v) => s + v, 0);
  // Max drawdown in R if every trade risked 1R, in entry order.
  let eq = 0, peak = 0, dd = 0;
  for (const v of rs) { eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, winPct: Math.round(win.length / n * 100), avgR: r2(mean), totalR: r2(mean * n), pf: loss > 0 ? r2(gain / loss) : null, t: sd > 0 ? r2(mean / (sd / Math.sqrt(n))) : null, maxDdR: r2(dd) };
}

export function variants() {
  const out = [];
  for (const gapTf of ['1d', '4h']) for (const gapKind of ['fvg', 'drop']) for (const trigTf of ['1h', '15m'])
    for (const deep of [false, true]) for (const trig of ['reclaim', 'rsi'])
      for (const target of ['middle', 'top', 'above', 'r15']) for (const btc of [false, true])
        out.push({ gapTf, gapKind, deep, trigTf, trig, target, btc });
  for (const trigTf of ['1h', '15m']) for (const trig of ['reclaim', 'rsi']) for (const btc of [false, true])
    out.push({ gapTf: trigTf, gapKind: null, trigTf, trig, target: 'r15', btc });
  return out;
}

const trigName = (v) => (v.trig === 'rsi' ? 'RSI>30' : 'RSI+EMA20');
const label = (v) => (v.gapKind ? `${v.deep ? 'DEEP ' : ''}${v.gapKind} ${v.gapTf} -> ${v.trigTf} ${trigName(v)}, tgt ${v.target}` : `CONTROL no gap, ${v.trigTf} ${trigName(v)}, +1.5R`) + (v.btc ? ', BTC>200d' : '');

function parseArgs(argv) {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const args = { months: 36, split: 0.6, symbols: DEFAULT_SYMBOLS, end: end.getTime(), cost: 0.25, cache: true };
  for (let k = 0; k < argv.length; k += 1) {
    const [flag, value] = [argv[k], argv[k + 1]];
    if (flag === '--months') { args.months = Number(value); k += 1; }
    else if (flag === '--split') { args.split = Number(value); k += 1; }
    else if (flag === '--symbols') { args.symbols = value.split(','); k += 1; }
    else if (flag === '--end') { args.end = Date.parse(value); k += 1; }
    else if (flag === '--cost') { args.cost = Number(value); k += 1; }
    else if (flag === '--no-cache') args.cache = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const splitMs = startMs + Math.round((args.end - startMs) * args.split);
  const data = {};
  for (const symbol of new Set([...args.symbols, BTC_SYMBOL])) {
    console.log(`  ${symbol}`);
    data[symbol] = {};
    for (const tf of TFS) {
      const raw = await loadRaw(symbol, tf, startMs - WARMUP_DAYS * DAY, args.end, args.cache);
      if (raw.length) data[symbol][tf] = pack(raw, tf);
    }
  }
  const btcDaily = data[BTC_SYMBOL]['1d'];
  const rows = [];
  for (const v of variants()) {
    const all = scanVariant(data, v, args.symbols, { startMs, endMs: args.end, costPct: args.cost, btcDaily });
    const train = all.filter((x) => x.entryMs < splitMs).map((x) => x.r);
    const test = all.filter((x) => x.entryMs >= splitMs).map((x) => x.r);
    const recent = all.filter((x) => x.entryMs >= args.end - 30 * DAY)
      .map((x) => ({ symbol: x.symbol, entry: day(x.entryMs), price: x.entry, r: r2(x.r), why: x.why }));
    rows.push({ name: label(v), variant: v, all: stats(all.map((x) => x.r)), train: stats(train), test: stats(test), recent });
  }
  console.log(`\nTrain ${day(startMs)} -> ${day(splitMs)}, test ${day(splitMs)} -> ${day(args.end)}, ${args.cost}% round-trip cost in R, ${args.symbols.length} coins.\n`);
  const fmt = (s) => (s.n ? `${String(s.n).padStart(4)} ${String(s.winPct).padStart(3)}% ${String(s.avgR).padStart(6)}R t${String(s.t).padStart(5)}` : '   0').padEnd(27);
  console.log(`${'variant'.padEnd(66)} ${'train n win avgR t'.padEnd(27)} ${'test n win avgR t'.padEnd(27)} all PF`);
  for (const row of rows) console.log(`${row.name.padEnd(66)} ${fmt(row.train)} ${fmt(row.test)} ${row.all.pf}`);
  const outDir = path.join(ROOT, 'benchmarks', `gap-research-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify({ args: { ...args, startMs, splitMs }, rows }, null, 2));
  console.log(`\nReport: ${path.relative(ROOT, outDir)}/report.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
