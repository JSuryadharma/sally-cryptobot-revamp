// "Time travel" comparison of alternative strategies against the robot, in
// 3-month trading windows (Joe, 2026-11-21).
//
// Two views, after day-trader-skill's time machine (trader-timemachine):
// 1. Replay: start trading on every Monday in the history, trade for 91 days,
//    measure the profit of that window (one equity curve per strategy, sliced).
// 2. Bootstrap: draw a 3-month batch of trades (as many as the strategy makes
//    in 3 months on average) at random from its own past trades, 2000 times,
//    and read the profit distribution.
//
//   KLINES_DIR=/var/lib/klines node scripts/timeTravel.mjs --market crypto --end 2026-11-15
//   IDX_DATA_DIR=/var/lib/idxfarid node scripts/timeTravel.mjs --market idx --symbols ADRO,ANTM,...
//
// Every strategy uses the same portfolio rules: 2% of equity risked per trade,
// at most 6 positions, at most a third of equity in one position, round-trip
// costs charged on every exit. The robot row for crypto is the real engine
// (advance() + autopilot + skill gate) from scripts/backtest.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsi } from '../src/indicators.js';
import { resolveEngineCfg } from '../src/engine/config.js';
import { DEFAULT_IDX_WATCHLIST } from '../src/markets/idx.js';
import { scanSetups } from '../src/tools/scanner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const TF_MS = { '1h': 3_600_000, '4h': 14_400_000, '1d': DAY };
const CRYPTO = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'TRXUSDT', 'NEARUSDT', 'ZECUSDT', 'PEPEUSDT', 'SUIUSDT', 'FETUSDT', 'ENAUSDT', 'AAVEUSDT'];
const WINDOW_DAYS = 91;

// ---------- indicators ----------
const sma = (v, n) => { const o = Array(v.length).fill(null); let s = 0; for (let k = 0; k < v.length; k += 1) { s += v[k]; if (k >= n) s -= v[k - n]; if (k >= n - 1) o[k] = s / n; } return o; };
const ema = (v, n) => { const o = Array(v.length).fill(null); const a = 2 / (n + 1); let e = null; for (let k = 0; k < v.length; k += 1) { e = e == null ? v[k] : e + a * (v[k] - e); if (k >= n - 1) o[k] = e; } return o; };
function atr(bars, n = 14) {
  const o = Array(bars.length).fill(null); let a = null;
  for (let k = 1; k < bars.length; k += 1) {
    const tr = Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close));
    a = k <= n ? (a ?? 0) + tr / n : (a * (n - 1) + tr) / n;
    if (k >= n) o[k] = a;
  }
  return o;
}
const priorMax = (v, n) => { const o = Array(v.length).fill(null); for (let k = n; k < v.length; k += 1) { let m = -Infinity; for (let j = k - n; j < k; j += 1) if (v[j] > m) m = v[j]; o[k] = m; } return o; };
const priorMin = (v, n) => { const o = Array(v.length).fill(null); for (let k = n; k < v.length; k += 1) { let m = Infinity; for (let j = k - n; j < k; j += 1) if (v[j] < m) m = v[j]; o[k] = m; } return o; };

function enrich(bars, tf) {
  const c = bars.map((b) => b.close);
  const v = bars.map((b) => b.volume || 0);
  return {
    tf, bars, c,
    closeMs: bars.map((b) => b.closeTime ?? b.time * 1000 + TF_MS[tf]),
    sma5: sma(c, 5), sma20: sma(c, 20), sma50: sma(c, 50), sma200: sma(c, 200), ema50: ema(c, 50), ema200: ema(c, 200),
    ema9: ema(c, 9), ema21: ema(c, 21),
    rsi2: rsi(c, 2), rsi14: rsi(c, 14), atr: atr(bars),
    hi10: priorMax(c, 10), hi20: priorMax(bars.map((b) => b.high), 20), hi24: priorMax(bars.map((b) => b.high), 24), hi30: priorMax(bars.map((b) => b.high), 30), hi55: priorMax(bars.map((b) => b.high), 55),
    lo10: priorMin(bars.map((b) => b.low), 10), lo20: priorMin(bars.map((b) => b.low), 20),
    vol24: sma(v, 24), v,
    ret30: c.map((x, k) => (k >= 30 ? x / c[k - 30] - 1 : null))
  };
}

// Latest index whose bar closed at or before ms (binary search).
function idxAt(s, ms) { let lo = 0, hi = s.closeMs.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.closeMs[m] <= ms) { f = m; lo = m + 1; } else hi = m - 1; } return f; }

// ---------- strategies ----------
// signal(ctx, sym, k) -> { stop, target?, maxBars, exit?(s, k, pos) } | null; entry at bar k's close.
function regimeOn(ctx, ms) { const d = ctx.regime; const j = idxAt(d, ms); return j >= 0 && d.sma200[j] != null && d.c[j] > d.sma200[j]; }
function dailyOf(ctx, sym, ms) { const d = ctx.data[sym]['1d']; const j = idxAt(d, ms); return j >= 0 ? { d, j } : null; }

export function strategies(market) {
  const list = [
    {
      key: 'robot55', name: 'Robot: 55-day breakout, 3 ATR, +3R (crypto) / +2R (IDX)', tf: '1d',
      signal: (ctx, sym, s, k) => (s.hi55[k] != null && s.c[k] > s.hi55[k] && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k]) ? { stop: s.c[k] - 3 * s.atr[k], targetR: market === 'idx' ? 2 : 3, maxBars: 30 } : null)
    },
    {
      key: 'turtle20', name: 'Daily 20-day breakout, trail exit at 10-day low (no target)', tf: '1d',
      signal: (ctx, sym, s, k) => (s.hi20[k] != null && s.c[k] > s.hi20[k] && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k]) ? { stop: s.c[k] - 2 * s.atr[k], maxBars: 120, exit: (s2, j) => s2.lo10[j] != null && s2.c[j] < s2.lo10[j] } : null)
    },
    {
      key: 'rsi2daily', name: 'Daily RSI(2) dip in uptrend (close > 200d, RSI2 < 10), exit close > 5d avg', tf: '1d',
      signal: (ctx, sym, s, k) => (s.sma200[k] != null && s.c[k] > s.sma200[k] && s.rsi2[k] != null && s.rsi2[k] < 10 && s.atr[k] > 0 ? { stop: s.c[k] - 3 * s.atr[k], maxBars: 10, exit: (s2, j) => s2.sma5[j] != null && s2.c[j] > s2.sma5[j] } : null)
    },
    {
      key: 'skillFlag', name: 'Skill bull flag (daily), 2 ATR, +2R', tf: '1d',
      signal: (ctx, sym, s, k) => {
        if (k < 30 || !(s.atr[k] > 0)) return null;
        const hits = scanSetups(s.bars.slice(k - 30, k + 1))?.setups || [];
        return hits.includes('bullFlag') ? { stop: s.c[k] - 2 * s.atr[k], targetR: 2, maxBars: 15 } : null;
      }
    },
    { key: 'rotation', name: 'Weekly momentum rotation: hold top 3 by 30-day return while regime is up', tf: '1d', rotation: true }
  ];
  if (market === 'crypto') {
    list.push(
      {
        key: 'donchian4h', name: '4h breakout of the 5-day high, BTC > 200d, 2 ATR, +2R, 7-day limit', tf: '4h',
        signal: (ctx, sym, s, k) => (s.hi30[k] != null && s.c[k] > s.hi30[k] && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k]) ? { stop: s.c[k] - 2 * s.atr[k], targetR: 2, maxBars: 42 } : null)
      },
      {
        key: 'momo1h', name: '1h day trade: break of the 24h high on 2x volume, 4h trend up, 1.5 ATR, +2R, 24h limit', tf: '1h',
        signal: (ctx, sym, s, k) => {
          if (!(s.hi24[k] != null && s.c[k] > s.hi24[k] && s.vol24[k] > 0 && s.v[k] > 2 * s.vol24[k] && s.atr[k] > 0)) return null;
          const h4 = ctx.data[sym]['4h']; const j = idxAt(h4, s.closeMs[k]);
          if (j < 0 || h4.ema50[j] == null || h4.c[j] < h4.ema50[j] || !regimeOn(ctx, s.closeMs[k])) return null;
          return { stop: s.c[k] - 1.5 * s.atr[k], targetR: 2, maxBars: 24 };
        }
      },
      {
        key: 'rsi2_4h', name: '4h RSI(2) dip in uptrend (4h > 200 EMA, daily > 50d), exit close > 5-bar avg', tf: '4h',
        signal: (ctx, sym, s, k) => {
          if (!(s.ema200[k] != null && s.c[k] > s.ema200[k] && s.rsi2[k] != null && s.rsi2[k] < 10 && s.atr[k] > 0)) return null;
          const dd = dailyOf(ctx, sym, s.closeMs[k]);
          if (!dd || dd.d.sma50[dd.j] == null || dd.d.c[dd.j] < dd.d.sma50[dd.j]) return null;
          return { stop: s.c[k] - 2.5 * s.atr[k], maxBars: 12, exit: (s2, j) => s2.sma5[j] != null && s2.c[j] > s2.sma5[j] };
        }
      },
      {
        key: 'ema4h', name: '4h trend: EMA9 crosses above EMA21 above the 200 EMA, exit on cross down', tf: '4h',
        signal: (ctx, sym, s, k) => (k > 0 && s.ema9[k - 1] != null && s.ema9[k - 1] <= s.ema21[k - 1] && s.ema9[k] > s.ema21[k] && s.ema200[k] != null && s.c[k] > s.ema200[k] && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k])
          ? { stop: s.c[k] - 2.5 * s.atr[k], maxBars: 90, exit: (s2, j) => s2.ema9[j] < s2.ema21[j] } : null)
      }
    );
  }
  return list;
}

// ---------- portfolio simulator ----------
export function simulateRule(rule, ctx, { startMs, endMs, risk = 0.02, maxPos = 6, maxFrac = 1 / 3, costPct }) {
  const cost = costPct / 100;
  let cash = 1;
  const pos = new Map();
  const trades = [];
  const equity = [];
  const syms = ctx.symbols.filter((s) => ctx.data[s]?.[rule.tf]);
  // Timeline of bar closes.
  const times = new Set();
  for (const s of syms) for (const t of ctx.data[s][rule.tf].closeMs) if (t > startMs && t <= endMs) times.add(t);
  const timeline = [...times].sort((a, b) => a - b);
  const ptr = Object.fromEntries(syms.map((s) => [s, Math.max(0, idxAt(ctx.data[s][rule.tf], startMs))]));
  const mtm = () => cash + [...pos.values()].reduce((a, p) => a + p.units * p.last, 0);
  let lastDay = null;
  let lastRebalance = null;
  for (const t of timeline) {
    const barsNow = [];
    for (const s of syms) {
      const ser = ctx.data[s][rule.tf];
      let k = ptr[s];
      while (k + 1 < ser.closeMs.length && ser.closeMs[k + 1] <= t) k += 1;
      ptr[s] = k;
      if (ser.closeMs[k] === t) barsNow.push([s, ser, k]);
    }
    if (rule.rotation) {
      // Rebalance once a week (first bar of each ISO week).
      const week = Math.floor((t - 4 * DAY) / (7 * DAY));
      for (const [s, ser, k] of barsNow) { const p = pos.get(s); if (p) p.last = ser.c[k]; }
      if (week !== lastRebalance) {
        lastRebalance = week;
        const on = regimeOn(ctx, t);
        const ranked = barsNow.filter(([, ser, k]) => ser.ret30[k] != null && ser.ret30[k] > 0).sort((a, b) => b[1].ret30[b[2]] - a[1].ret30[a[2]]).slice(0, 3);
        const want = new Set(on ? ranked.map(([s]) => s) : []);
        for (const [s, p] of [...pos]) {
          if (want.has(s)) continue;
          const gross = p.units * p.last; cash += gross * (1 - cost / 2);
          trades.push({ sym: s, entryT: p.t, exitT: t, r: null, pct: (p.last / p.entry - 1) - cost });
          pos.delete(s);
        }
        const eq = mtm();
        for (const [s, ser, k] of ranked) {
          if (!want.has(s) || pos.has(s)) continue;
          const alloc = Math.min(eq / 3, cash); if (alloc <= 0) continue;
          cash -= alloc; pos.set(s, { units: (alloc * (1 - cost / 2)) / ser.c[k], entry: ser.c[k], last: ser.c[k], t });
        }
      }
    } else {
      // Exits first.
      for (const [s, ser, k] of barsNow) {
        const p = pos.get(s); if (!p) continue;
        const b = ser.bars[k]; let exit = null;
        if (b.open <= p.stop) exit = b.open; else if (b.low <= p.stop) exit = p.stop;
        else if (p.target && b.open >= p.target) exit = b.open; else if (p.target && b.high >= p.target) exit = p.target;
        else if (p.exitFn && p.exitFn(ser, k)) exit = b.close;
        else if (k - p.k >= p.maxBars) exit = b.close;
        p.last = b.close;
        if (exit != null) {
          cash += p.units * exit - p.units * p.entry * cost;
          trades.push({ sym: s, entryT: p.t, exitT: t, r: (exit - p.entry) / (p.entry - p.stop) - (p.entry * cost) / (p.entry - p.stop), pct: exit / p.entry - 1 - cost });
          pos.delete(s);
        }
      }
      // Entries.
      const cands = [];
      for (const [s, ser, k] of barsNow) {
        if (pos.has(s)) continue;
        const sig = rule.signal(ctx, s, ser, k);
        if (sig && sig.stop > 0 && sig.stop < ser.c[k]) cands.push([s, ser, k, sig]);
      }
      cands.sort((a, b) => (b[1].v[b[2]] * b[1].c[b[2]]) - (a[1].v[a[2]] * a[1].c[a[2]]));
      for (const [s, ser, k, sig] of cands) {
        if (pos.size >= maxPos) break;
        const eq = mtm(); const entry = ser.c[k]; const dist = entry - sig.stop;
        const value = Math.min((eq * risk) / (dist / entry), eq * maxFrac, cash);
        if (value < eq * 0.01) continue;
        cash -= value;
        pos.set(s, { units: value / entry, entry, stop: sig.stop, target: sig.targetR ? entry + sig.targetR * dist : null, maxBars: sig.maxBars, exitFn: sig.exit, k, t, last: entry });
      }
    }
    const dayKey = Math.floor(t / DAY);
    if (dayKey !== lastDay) { lastDay = dayKey; equity.push({ t, eq: mtm() }); }
  }
  equity.push({ t: endMs, eq: mtm() });
  return { equity, trades };
}

// ---------- time travel ----------
function pct(v, q) { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; }
const r1 = (x) => Math.round(x * 10) / 10;

export function windows(equity, trades, { startMs, endMs }) {
  const eqAt = (ms) => { let lo = 0, hi = equity.length - 1, f = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (equity[m].t <= ms) { f = m; lo = m + 1; } else hi = m - 1; } return equity[f].eq; };
  const out = [];
  for (let s = startMs; s + WINDOW_DAYS * DAY <= endMs; s += 7 * DAY) {
    const e = s + WINDOW_DAYS * DAY;
    let peak = eqAt(s), dd = 0;
    for (const p of equity) { if (p.t < s || p.t > e) continue; peak = Math.max(peak, p.eq); dd = Math.max(dd, 1 - p.eq / peak); }
    out.push({ s, ret: (eqAt(e) / eqAt(s) - 1) * 100, dd: dd * 100, n: trades.filter((x) => x.entryT >= s && x.entryT < e).length });
  }
  return out;
}

// Skill-style bootstrap: random 3-month batches of the strategy's own trades.
export function bootstrap(trades, perWindow, { paths = 2000, seed = 19, risk = 0.02 } = {}) {
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = Math.max(1, Math.round(perWindow));
  const vals = [];
  for (let p = 0; p < paths; p += 1) {
    let eq = 1;
    for (let k = 0; k < n; k += 1) { const tr = trades[Math.floor(rand() * trades.length)]; eq *= 1 + (tr.r != null ? risk * tr.r : tr.pct / 3); }
    vals.push((eq - 1) * 100);
  }
  return { median: r1(pct(vals, 0.5)), p10: r1(pct(vals, 0.1)), p90: r1(pct(vals, 0.9)), pProfit: Math.round((vals.filter((v) => v > 0).length / paths) * 100) };
}

export function summarize(name, equity, trades, range) {
  const w = windows(equity, trades, range);
  const rets = w.map((x) => x.ret);
  const last = w.at(-1);
  const wins = trades.filter((t) => (t.r ?? t.pct) > 0).length;
  const perWindow = w.length ? w.reduce((a, x) => a + x.n, 0) / w.length : 0;
  const total = (equity.at(-1).eq / equity[0].eq - 1) * 100;
  // Return per 12-month block from the start (robustness across market phases).
  const eqAt = (ms) => { let f = equity[0].eq; for (const p of equity) { if (p.t > ms) break; f = p.eq; } return f; };
  const years = [];
  for (let s = range.startMs; s < range.endMs - 30 * DAY; s += 365 * DAY) years.push(r1((eqAt(Math.min(s + 365 * DAY, range.endMs)) / eqAt(s) - 1) * 100));
  return {
    name, windows: w.length, years: years.join(' / '),
    median3m: r1(pct(rets, 0.5)), avg3m: r1(rets.reduce((a, b) => a + b, 0) / rets.length), worst3m: r1(Math.min(...rets)), best3m: r1(Math.max(...rets)),
    pProfit3m: Math.round((rets.filter((x) => x > 0).length / rets.length) * 100),
    trades3m: r1(perWindow), winPct: trades.length ? Math.round((wins / trades.length) * 100) : null,
    avgDd3m: r1(w.reduce((a, x) => a + x.dd, 0) / w.length),
    last3m: last ? r1(last.ret) : null, last3mFrom: last ? new Date(last.s).toISOString().slice(0, 10) : null,
    totalPct: r1(total),
    boot: trades.length >= 10 ? bootstrap(trades, perWindow) : null
  };
}

// ---------- data ----------
async function loadCtx(market, symbols) {
  const data = {};
  if (market === 'crypto') {
    for (const s of symbols) {
      data[s] = {};
      for (const tf of ['1h', '4h', '1d']) data[s][tf] = enrich(JSON.parse(await fs.readFile(path.join(process.env.KLINES_DIR, `${s}_${tf}.json`), 'utf8')), tf);
    }
    return { data, symbols, regime: data.BTCUSDT['1d'] };
  }
  for (const s of [...symbols, 'IHSG']) data[s] = { '1d': enrich(JSON.parse(await fs.readFile(path.join(process.env.IDX_DATA_DIR, `${s}.json`), 'utf8')), '1d') };
  return { data, symbols, regime: data.IHSG['1d'] };
}

async function robotEngine(startMs, endMs, symbols) {
  const { loadSeries, simulate } = await import('./backtest.mjs');
  const series = await loadSeries({ symbols, startMs, endMs, useCache: true });
  const out = {};
  const variants = [
    ['Robot (live engine, skill gate)', {}, true],
    ['Robot (engine, before skill gate)', { preTrade: null }, true],
    ['Engine: breakout 20d, exit at 10-day low + gap sleeve', { profiles: { breakout: false, breakout55: false, breakoutTrail: true, gap: true } }, false],
    ['Engine: breakout 20d, exit at 10-day low, daily-close entry + gap', { breakoutEntry: 'close', profiles: { breakout: false, breakout55: false, breakoutTrail: true, gap: true } }, false]
  ].filter(([label]) => !process.env.ENGINE_ONLY || label.includes(process.env.ENGINE_ONLY));
  for (const [label, over, autopilot] of variants) {
    const cfg = resolveEngineCfg({ roundTripCostPct: 0.2, slippagePct: 0.05, ...over });
    const { equityCurve, transactions } = simulate(series, { symbols, startMs, endMs, autopilot, cfg });
    const equity = equityCurve.map((p) => ({ t: Date.parse(p.date) + DAY, eq: p.equityIdr }));
    const trades = transactions.filter((t) => t.type === 'SELL' && !t.partial).map((t) => ({ entryT: Date.parse(t.openedAt || t.createdAt), exitT: Date.parse(t.createdAt), r: t.rMultiple, pct: null }));
    out[label] = { equity, trades };
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const market = arg('market', 'crypto');
  const endMs = Date.parse(arg('end', market === 'idx' ? '2026-11-20' : '2026-11-15'));
  const months = Number(arg('months', market === 'idx' ? 60 : 36));
  const startMs = endMs - months * 30 * DAY;
  const symbols = (arg('symbols', '') || (market === 'idx' ? DEFAULT_IDX_WATCHLIST.join(',') : CRYPTO.join(','))).split(',');
  const costPct = Number(arg('cost', market === 'idx' ? 0.4 : 0.25));
  const ctx = await loadCtx(market, symbols);
  const rows = [];
  if (market === 'crypto' && !argv.includes('--no-engine')) {
    const eng = await robotEngine(startMs, endMs, symbols);
    for (const [name, r] of Object.entries(eng)) rows.push(summarize(name, r.equity, r.trades, { startMs, endMs }));
  }
  for (const rule of strategies(market)) {
    const t0 = Date.now();
    const { equity, trades } = simulateRule(rule, ctx, { startMs, endMs, costPct });
    rows.push({ key: rule.key, ...summarize(rule.name, equity, trades, { startMs, endMs }) });
    process.stderr.write(`${rule.key} ${trades.length} trades ${Date.now() - t0}ms\n`);
  }
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.table(rows.map(({ boot, ...r }) => ({ ...r, bootMedian: boot?.median, bootP10: boot?.p10, bootProfit: boot?.pProfit })));
  await fs.mkdir(path.join(ROOT, 'reports'), { recursive: true });
  const file = path.join(ROOT, 'reports', `time-travel-${market}-${day(endMs)}.json`);
  await fs.writeFile(file, JSON.stringify({ market, start: day(startMs), end: day(endMs), symbols, costPct, windowDays: WINDOW_DAYS, rows }, null, 2));
  console.log(`Written ${path.relative(ROOT, file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
