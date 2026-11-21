// Strategy combination lab (Joe, 2026-11-21): the robot's 55-day breakout
// against combinations with day-trader-skill setups, RSI / EMA / Fear & Greed /
// ATR filters and daily/4h market-structure rules, on one portfolio model
// (scripts/timeTravel.mjs simulateRule: 2% risk, 6 positions, 30% cap, costs).
//
//   KLINES_DIR=/var/lib/klines FNG_CSV=/var/lib/fng/fng.csv node scripts/comboLab.mjs --end 2026-11-14 --out lab.json
//
// Fear & Greed: alternative.me daily index (mirror: PXLabs-code/crypto-market-indicators
// data/market/fear_greed.csv). A daily bar uses the value published for its own date.
import fs from 'node:fs/promises';
import { loadCtx, simulateRule, idxAt, regimeOn } from './timeTravel.mjs';
import { scanSetups } from '../src/tools/scanner.js';

const DAY = 86_400_000;
const CRYPTO = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'TRXUSDT', 'NEARUSDT', 'ZECUSDT', 'PEPEUSDT', 'SUIUSDT', 'FETUSDT', 'ENAUSDT', 'AAVEUSDT'];
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, k, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[k + 1]]] : a), []));
const END = Date.parse(args.end || '2026-11-14');

async function loadFng(file) {
  const map = new Map();
  for (const line of (await fs.readFile(file, 'utf8')).split('\n').slice(1)) {
    const [ts, v] = line.split(',');
    if (ts && v) map.set(ts.slice(0, 10), Number(v));
  }
  return map;
}
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Confirmed swing points (3 bars each side): known only 3 bars after the pivot.
function swings(s, n = 3) {
  const len = s.bars.length;
  const lastSH = Array(len).fill(null), lastSL = Array(len).fill(null), prevSL = Array(len).fill(null), prevSH = Array(len).fill(null);
  let sh = null, sl = null, psl = null, psh = null;
  for (let k = 0; k < len; k += 1) {
    const j = k - n;
    if (j >= n) {
      const h = s.bars[j].high, l = s.bars[j].low;
      let isH = true, isL = true;
      for (let q = j - n; q <= j + n; q += 1) { if (q === j) continue; if (s.bars[q].high >= h) isH = false; if (s.bars[q].low <= l) isL = false; }
      if (isH) { psh = sh; sh = h; }
      if (isL) { psl = sl; sl = l; }
    }
    lastSH[k] = sh; lastSL[k] = sl; prevSL[k] = psl; prevSH[k] = psh;
  }
  return { lastSH, lastSL, prevSL, prevSH };
}

function prep(ctx, fng) {
  for (const sym of ctx.symbols) {
    for (const tf of ['1d', '4h']) {
      const s = ctx.data[sym][tf];
      Object.assign(s, swings(s));
      s.atr50 = s.atr.map((_, k) => { if (k < 50) return null; let t = 0, c = 0; for (let q = k - 49; q <= k; q += 1) if (s.atr[q] != null) { t += s.atr[q]; c += 1; } return c ? t / c : null; });
      s.fng = s.closeMs.map((ms) => fng.get(dateOf(ms - DAY)) ?? null);
      s.fng7 = s.fng.map((_, k) => { const w = s.fng.slice(Math.max(0, k - 6), k + 1).filter((x) => x != null); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null; });
    }
  }
}

const breakout55 = (ctx, s, k) => s.hi55[k] != null && s.c[k] > s.hi55[k] && s.atr[k] > 0;
const robotExit = (s, k) => ({ stop: s.c[k] - 3 * s.atr[k], targetR: 3, maxBars: 30 });
const f = {
  regime: (ctx, s, k) => regimeOn(ctx, s.closeMs[k]),
  rsi: (ctx, s, k) => s.rsi14[k] != null && s.rsi14[k] >= 60,
  ema: (ctx, s, k) => s.ema50[k] != null && s.ema200[k] != null && s.c[k] > s.ema50[k] && s.ema50[k] > s.ema200[k],
  fngOk: (ctx, s, k) => s.fng[k] != null && s.fng[k] < 80,
  fngUp: (ctx, s, k) => s.fng[k] != null && s.fng7[k] != null && s.fng[k] >= s.fng7[k],
  atrQuiet: (ctx, s, k) => s.atr50[k] != null && s.atr[k] <= 1.2 * s.atr50[k],
  hl: (ctx, s, k) => s.lastSL[k] != null && s.prevSL[k] != null && s.lastSL[k] > s.prevSL[k],
  skill: (ctx, s, k) => k >= 40 && (scanSetups(s.bars.slice(k - 40, k + 1))?.setups || []).filter((x) => x !== 'breakout20').length >= 1
};
const robotWith = (...filters) => (ctx, sym, s, k) => (breakout55(ctx, s, k) && filters.every((fn) => fn(ctx, s, k)) ? robotExit(s, k) : null);

export const COMBOS = [
  { key: 'robot', group: 'Robot', name: 'Robot sekarang: breakout 55 hari, BTC > 200d, stop 3 ATR, target +3R', tf: '1d', signal: robotWith(f.regime) },
  { key: 'robot_rsi', group: 'Robot + indikator', name: 'Robot + RSI(14) ≥ 60', tf: '1d', signal: robotWith(f.regime, f.rsi) },
  { key: 'robot_ema', group: 'Robot + indikator', name: 'Robot + tren EMA (harga > EMA50 > EMA200)', tf: '1d', signal: robotWith(f.regime, f.ema) },
  { key: 'robot_fng', group: 'Robot + indikator', name: 'Robot + Fear & Greed < 80 (hindari serakah ekstrem)', tf: '1d', signal: robotWith(f.regime, f.fngOk) },
  { key: 'robot_fngup', group: 'Robot + indikator', name: 'Robot + Fear & Greed naik (≥ rata-rata 7 hari)', tf: '1d', signal: robotWith(f.regime, f.fngUp) },
  { key: 'robot_atr', group: 'Robot + indikator', name: 'Robot + ATR tenang sebelum breakout (ATR14 ≤ 1,2× ATR50)', tf: '1d', signal: robotWith(f.regime, f.atrQuiet) },
  { key: 'robot_all', group: 'Robot + indikator', name: 'Robot + RSI + EMA + F&G + ATR sekaligus', tf: '1d', signal: robotWith(f.regime, f.rsi, f.ema, f.fngOk, f.atrQuiet) },
  { key: 'robot_fng_noregime', group: 'Robot + indikator', name: 'Breakout 55 hari tanpa filter BTC, ganti F&G 40-79', tf: '1d', signal: robotWith(f.ema, (ctx, s, k) => s.fng[k] != null && s.fng[k] >= 40 && s.fng[k] < 80) },
  { key: 'robot_hl', group: 'Robot + market structure', name: 'Robot + struktur higher low (swing low terakhir > sebelumnya)', tf: '1d', signal: robotWith(f.regime, f.hl) },
  {
    key: 'bos_daily', group: 'Market structure', name: 'BOS harian: tutup di atas swing high terakhir setelah higher low, BTC > 200d, stop di bawah swing low (maks 3 ATR), +3R', tf: '1d',
    signal: (ctx, sym, s, k) => {
      if (!(k > 0 && s.lastSH[k] != null && s.c[k] > s.lastSH[k] && s.c[k - 1] <= s.lastSH[k] && f.hl(ctx, s, k) && f.regime(ctx, s, k) && s.atr[k] > 0)) return null;
      const stop = Math.max(s.lastSL[k], s.c[k] - 3 * s.atr[k]);
      return stop < s.c[k] - 0.5 * s.atr[k] ? { stop, targetR: 3, maxBars: 30 } : null;
    }
  },
  {
    key: 'bos_4h', group: 'Market structure', name: 'BOS 4 jam dalam tren harian naik (harian > EMA50, BTC > 200d), stop swing low 4j (maks 3 ATR), +2R', tf: '4h',
    signal: (ctx, sym, s, k) => {
      if (!(k > 0 && s.lastSH[k] != null && s.c[k] > s.lastSH[k] && s.c[k - 1] <= s.lastSH[k] && f.hl(ctx, s, k) && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k]))) return null;
      const d = ctx.data[sym]['1d']; const j = idxAt(d, s.closeMs[k]);
      if (j < 0 || d.ema50[j] == null || d.c[j] < d.ema50[j]) return null;
      const stop = Math.max(s.lastSL[k], s.c[k] - 3 * s.atr[k]);
      return stop < s.c[k] - 0.5 * s.atr[k] ? { stop, targetR: 2, maxBars: 42 } : null;
    }
  },
  {
    key: 'robot_struct_exit', group: 'Robot + market structure', name: 'Robot, tanpa target: jual saat tutup harian di bawah swing low terakhir (stop 3 ATR)', tf: '1d',
    signal: (ctx, sym, s, k) => (breakout55(ctx, s, k) && f.regime(ctx, s, k) ? { stop: s.c[k] - 3 * s.atr[k], maxBars: 120, exit: (s2, j) => s2.lastSL[j] != null && s2.c[j] < s2.lastSL[j] } : null)
  },
  { key: 'robot_skill', group: 'Robot + skill', name: 'Robot + minimal 1 setup skill di hari yang sama (bull flag, reclaim SMA20, oversold bounce)', tf: '1d', signal: robotWith(f.regime, f.skill) },
  {
    key: 'skill_flag_combo', group: 'Skill + indikator', name: 'Skill bull flag + RSI ≥ 50 + harga > EMA50 + BTC > 200d, 2 ATR, +2R', tf: '1d',
    signal: (ctx, sym, s, k) => {
      if (!(k >= 30 && s.atr[k] > 0 && s.rsi14[k] >= 50 && s.ema50[k] != null && s.c[k] > s.ema50[k] && f.regime(ctx, s, k))) return null;
      return (scanSetups(s.bars.slice(k - 30, k + 1))?.setups || []).includes('bullFlag') ? { stop: s.c[k] - 2 * s.atr[k], targetR: 2, maxBars: 15 } : null;
    }
  },
  {
    key: 'fear_bounce', group: 'Skill + indikator', name: 'Kontrarian: F&G ≤ 20 + skill oversold bounce (RSI keluar dari < 30), 2 ATR, +2R, 10 hari', tf: '1d',
    signal: (ctx, sym, s, k) => {
      if (!(k >= 30 && s.atr[k] > 0 && s.fng[k] != null && s.fng[k] <= 20)) return null;
      return (scanSetups(s.bars.slice(k - 30, k + 1))?.setups || []).includes('oversoldBounce') ? { stop: s.c[k] - 2 * s.atr[k], targetR: 2, maxBars: 10 } : null;
    }
  },
  {
    key: 'ema_rsi_4h', group: 'Indikator', name: '4 jam: EMA9 potong naik EMA21 di atas EMA200, RSI ≥ 50, F&G < 80, BTC > 200d; keluar saat potong turun', tf: '4h',
    signal: (ctx, sym, s, k) => (k > 0 && s.ema9[k - 1] != null && s.ema9[k - 1] <= s.ema21[k - 1] && s.ema9[k] > s.ema21[k] && s.ema200[k] != null && s.c[k] > s.ema200[k] && s.rsi14[k] >= 50 && s.fng[k] != null && s.fng[k] < 80 && s.atr[k] > 0 && regimeOn(ctx, s.closeMs[k])
      ? { stop: s.c[k] - 2.5 * s.atr[k], maxBars: 90, exit: (s2, j) => s2.ema9[j] < s2.ema21[j] } : null)
  }
];

function stats(equity, trades, startMs, endMs, start = 20_000_000) {
  let peak = -Infinity, dd = 0;
  for (const e of equity) { peak = Math.max(peak, e.eq); dd = Math.max(dd, 1 - e.eq / peak); }
  const final = equity.at(-1).eq;
  const closed = trades.filter((t) => t.exitT > startMs && t.exitT <= endMs);
  const wins = closed.filter((t) => t.pct > 0).length;
  return { ret: Math.round((final - 1) * 1000) / 10, dd: Math.round(dd * 1000) / 10, n: closed.length, win: closed.length ? Math.round(wins / closed.length * 100) : null, final: Math.round(start * final) };
}

function rolling(equity, days = 91) {
  const out = [];
  for (let i = 0; i < equity.length; i += 7) {
    const target = equity[i].t + days * DAY;
    const j = equity.findIndex((e) => e.t >= target);
    if (j < 0) break;
    out.push(equity[j].eq / equity[i].eq - 1);
  }
  return { pos: Math.round(out.filter((x) => x > 0).length / out.length * 100), avg: Math.round(out.reduce((a, b) => a + b, 0) / out.length * 1000) / 10, worst: Math.round(Math.min(...out) * 1000) / 10 };
}

async function main() {
  const ctx = await loadCtx('crypto', CRYPTO);
  prep(ctx, await loadFng(process.env.FNG_CSV));
  const costPct = 0.25;
  const START = 20_000_000;
  const out = { end: dateOf(END), combos: [] };
  for (const c of COMBOS.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').includes(x.key))) {
    const row = { key: c.key, group: c.group, name: c.name, windows: {} };
    for (const [w, days] of [['1m', 30], ['3m', 91], ['6m', 182]]) {
      const startMs = END - days * DAY;
      const { equity, trades } = simulateRule(c, ctx, { startMs, endMs: END, risk: 0.02, maxPos: 6, maxFrac: 0.3, costPct });
      row.windows[w] = {
        ...stats(equity, trades, startMs, END),
        eq: equity.map((e) => [dateOf(e.t), Math.round(e.eq * START)]),
        trades: trades.map((t) => ({ sym: t.sym.replace('USDT', ''), buyT: t.entryT, sellT: t.exitT, buy: t.entry, sell: t.exit, why: t.why, spend: Math.round(t.value * START), pnl: Math.round(t.pnl * START), pct: Math.round(t.pct * 1000) / 10 }))
      };
    }
    const s3 = END - 1096 * DAY, split = END - 365 * DAY;
    const full = simulateRule(c, ctx, { startMs: s3, endMs: END, risk: 0.02, maxPos: 6, maxFrac: 0.3, costPct });
    const a = simulateRule(c, ctx, { startMs: s3, endMs: split, risk: 0.02, maxPos: 6, maxFrac: 0.3, costPct });
    const b = simulateRule(c, ctx, { startMs: split, endMs: END, risk: 0.02, maxPos: 6, maxFrac: 0.3, costPct });
    row.y3 = { ...stats(full.equity, full.trades, s3, END), roll: rolling(full.equity), first2y: stats(a.equity, a.trades, s3, split).ret, last1y: stats(b.equity, b.trades, split, END).ret };
    out.combos.push(row);
    const W = row.windows;
    console.log([c.key.padEnd(20), `1m ${W['1m'].ret}% (${W['1m'].n})`, `3m ${W['3m'].ret}% (${W['3m'].n})`, `6m ${W['6m'].ret}% (${W['6m'].n})`, `3y ${row.y3.ret}% DD ${row.y3.dd}% n ${row.y3.n} win ${row.y3.win}%`, `2y ${row.y3.first2y}% / 1y ${row.y3.last1y}%`, `roll3m +${row.y3.roll.pos}% avg ${row.y3.roll.avg} worst ${row.y3.roll.worst}`].join(' | '));
  }
  if (args.out) await fs.writeFile(args.out, JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });
