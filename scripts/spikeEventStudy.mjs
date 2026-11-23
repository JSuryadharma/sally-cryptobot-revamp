// Event study for engine/dca.js: after a 1h selling spike (range >= X x 1h
// ATR14, volume >= Y x 1h average), does price bounce more, and fall less,
// than at other moments of a similar pullback? Uses every coin and every day,
// not only the robot's trades, so the samples are large.
//
//   KLINES_DIR=... node scripts/spikeEventStudy.mjs [--split 2025-09-10]
import fs from 'node:fs/promises';
import path from 'node:path';
import { enrichCandles } from '../src/indicators.js';
import { DEFAULT_SYMBOLS } from './backtest.mjs';

const DIR = process.env.KLINES_DIR;
const split = Date.parse(process.argv.includes('--split') ? process.argv[process.argv.indexOf('--split') + 1] : '2025-09-10');
const H = 3_600_000, D = 86_400_000;
const load = async (s, tf) => JSON.parse(await fs.readFile(path.join(DIR, `${s}_${tf}.json`), 'utf8'));

function idxAtOrBefore(bars, ms, tfMs) { // last bar closed at or before ms
  let lo = 0, hi = bars.length - 1, f = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time * 1000 + tfMs <= ms) { f = m; lo = m + 1; } else hi = m - 1; }
  return f;
}

const buckets = {};
function add(key, period, ev) { ((buckets[key] ||= { train: [], test: [] })[period]).push(ev); }

for (const sym of DEFAULT_SYMBOLS) {
  const h1 = enrichCandles(await load(sym, '1h'));
  const d1 = enrichCandles(await load(sym, '1d'));
  let lastEvent = {};
  for (let i = 30; i < h1.length - 24 * 7; i += 1) {
    const b = h1[i], ref = h1[i - 1];
    if (!(ref.atr14 > 0) || !(ref.volumeSma20 > 0)) continue;
    const closeMs = b.time * 1000 + H;
    const di = idxAtOrBefore(d1, closeMs, D);
    if (di < 20) continue;
    const dATR = d1[di].atr14;
    let hi20 = 0; for (let k = di - 19; k <= di; k += 1) hi20 = Math.max(hi20, d1[k].high);
    // A trade-like pullback: 1 to 6 daily ATR under the 20-day high.
    const depth = (hi20 - b.close) / dATR;
    if (!(depth >= 1 && depth <= 6)) continue;
    const range = (Math.max(b.high, ref.close) - Math.min(b.low, ref.close)) / ref.atr14;
    const volX = b.volume / ref.volumeSma20;
    const red = b.close < ref.close;
    let key = null;
    if (red && range >= 3 && volX >= 3) key = 'spike 3xATR 3xVol';
    else if (red && range >= 2 && volX >= 2) key = 'spike 2xATR 2xVol';
    else if (red && range >= 2 && volX < 1.5) key = 'spike 2xATR, low volume';
    else if (range < 1.5) key = 'no spike (control)';
    if (!key) continue;
    // One event per coin per bucket per day.
    if (lastEvent[key] && closeMs - lastEvent[key] < D) continue;
    lastEvent[key] = closeMs;
    const p = b.close;
    const fwd = (n) => (h1[i + n].close / p - 1) * 100;
    let mae = 0, mfe = 0;
    for (let k = i + 1; k <= i + 24 * 7; k += 1) { mae = Math.min(mae, (h1[k].low - p) / dATR); mfe = Math.max(mfe, (h1[k].high - p) / dATR); }
    // DCA-style outcome: from here, does price gain +1 daily ATR before it loses 1.5 (the hard stop distance)?
    let hit = 0;
    for (let k = i + 1; k <= i + 24 * 7; k += 1) {
      if (h1[k].low <= p - 1.5 * dATR) { hit = -1; break; }
      if (h1[k].high >= p + 1 * dATR) { hit = 1; break; }
    }
    add(key, closeMs < split ? 'train' : 'test', { sym, t: new Date(closeMs).toISOString(), f24: fwd(24), f72: fwd(72), f168: fwd(168), mae, mfe, hit, range, volX });
  }
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d));
const out = [];
for (const [key, per] of Object.entries(buckets)) {
  for (const period of ['train', 'test']) {
    const e = per[period];
    const decided = e.filter((x) => x.hit !== 0);
    const row = {
      bucket: key, period, n: e.length,
      avg24: f(avg(e.map((x) => x.f24))), avg72: f(avg(e.map((x) => x.f72))), avg7d: f(avg(e.map((x) => x.f168))),
      med7d: f(med(e.map((x) => x.f168))), up7dPct: f((e.filter((x) => x.f168 > 0).length / e.length) * 100, 0),
      maeATR: f(avg(e.map((x) => x.mae))), worstMaeATR: f(Math.min(...e.map((x) => x.mae))),
      plus1BeforeMinus15Pct: decided.length ? f((decided.filter((x) => x.hit > 0).length / decided.length) * 100, 0) : '-'
    };
    out.push(row);
  }
}
out.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.period.localeCompare(b.period));
console.table(out);
console.log(JSON.stringify(out));
