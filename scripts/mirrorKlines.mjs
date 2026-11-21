// Builds KLINES_DIR from a public GitHub mirror of Binance spot 1m klines when
// Binance itself is unreachable (cloud sessions). Usage:
//   KLINES_OUT=/var/lib/klines node scripts/mirrorKlines.mjs BTCUSDT ETHUSDT ...

import fs from 'node:fs/promises';
const OUT = process.env.KLINES_OUT || '/var/lib/klines';
await fs.mkdir(OUT, { recursive: true });
const SYMS = process.argv.slice(2);
const TFS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const months = [];
for (let i = 2022 * 12 + 5; i <= 2026 * 12 + 10; i++) months.push([Math.floor(i / 12), String((i % 12) + 1).padStart(2, '0')]);
async function one(sym) {
  const agg = Object.fromEntries(Object.keys(TFS).map((t) => [t, new Map()]));
  let got = 0;
  for (const [y, m] of months) {
    const url = `https://raw.githubusercontent.com/parshant231234-eng/${sym}-Historical-Data/main/1m/${y}/${m}/${sym}_1m_${y}-${m}.csv`;
    let text = null;
    for (let a = 0; a < 4 && text == null; a++) { try { const r = await fetch(url); if (r.status === 404) break; if (!r.ok) throw new Error(r.status); text = await r.text(); } catch (e) { await new Promise((r) => setTimeout(r, 1500 * (a + 1))); } }
    if (text == null) continue;
    got++;
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(','); if (p.length < 7) continue;
      const t = Math.floor(Number(p[0]) / 1000), o = +p[2], h = +p[3], l = +p[4], c = +p[5], v = +p[6];
      if (!Number.isFinite(c)) continue;
      for (const [tf, s] of Object.entries(TFS)) {
        const k = t - (t % s); const map = agg[tf]; const b = map.get(k);
        if (!b) map.set(k, { time: k, open: o, high: h, low: l, close: c, volume: v, _last: t });
        else { if (h > b.high) b.high = h; if (l < b.low) b.low = l; if (t >= b._last) { b.close = c; b._last = t; } b.volume += v; }
      }
    }
  }
  for (const [tf, map] of Object.entries(agg)) {
    const arr = [...map.values()].sort((a, b) => a.time - b.time).map(({ _last, ...b }) => b);
    await fs.writeFile(`${OUT}/${sym}_${tf}.json`, JSON.stringify(arr));
  }
  const d = [...agg['1d'].values()].sort((a, b) => a.time - b.time);
  console.log(sym, 'months', got, '1d bars', d.length, d.length ? new Date(d[0].time * 1000).toISOString().slice(0, 10) + '..' + new Date(d.at(-1).time * 1000).toISOString().slice(0, 10) : '');
}
const queue = [...SYMS]; 
await Promise.all([0, 1, 2].map(async () => { while (queue.length) await one(queue.shift()); }));
