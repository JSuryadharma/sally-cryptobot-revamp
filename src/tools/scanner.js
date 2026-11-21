// Daily setup scanner, ported from day-trader-skill's trader-scanner (scan.py,
// daily mode) and rewritten in JS. Works on closed daily candles only (the
// skill also ignores today's bar until the close), for crypto and IDX alike.
//
// Setups (c = closes, last = c[-1]):
// - breakout20     last > max(c[-21..-2])                    (new 20-day closing high)
// - bullFlag       c[-6]/c[-16] - 1 > 10% and the last 5 closes within a 5% range
// - reclaimMa20    c[-2] below its SMA20 and last above today's SMA20
// - oversold       RSI14 (Wilder) < 30
// - oversoldBounce RSI14 yesterday < 30 and last > c[-2]
// Liquidity floor per market (the skill used price >= $5 and 1M shares a day).
// Results are sorted by traded value, like the skill.
import { rsi } from '../indicators.js';

export const SETUP_LABELS = {
  breakout20: '20-day closing high',
  bullFlag: 'Bull flag',
  reclaimMa20: 'Reclaimed SMA20',
  oversold: 'Oversold (RSI < 30)',
  oversoldBounce: 'Oversold bounce'
};

function sma(values, end, n) {
  if (end + 1 < n) return null;
  let s = 0;
  for (let k = end - n + 1; k <= end; k += 1) s += values[k];
  return s / n;
}

export function scanSetups(daily) {
  const bars = (daily || []).filter((b) => Number.isFinite(b.close));
  if (bars.length < 30) return null;
  const c = bars.map((b) => b.close);
  const n = c.length;
  const last = c[n - 1];
  const r = rsi(c, 14);
  const setups = [];
  let prior20 = -Infinity;
  for (let k = n - 21; k < n - 1; k += 1) prior20 = Math.max(prior20, c[k]);
  if (last > prior20) setups.push('breakout20');
  const last5 = c.slice(-5);
  if (c[n - 6] / c[n - 16] - 1 > 0.10 && (Math.max(...last5) - Math.min(...last5)) / last < 0.05) setups.push('bullFlag');
  const smaPrev = sma(c, n - 2, 20);
  const smaNow = sma(c, n - 1, 20);
  if (smaPrev != null && c[n - 2] < smaPrev && last > smaNow) setups.push('reclaimMa20');
  if (r[n - 1] != null && r[n - 1] < 30) setups.push('oversold');
  if (r[n - 2] != null && r[n - 2] < 30 && last > c[n - 2]) setups.push('oversoldBounce');
  const lastBar = bars.at(-1);
  return {
    setups,
    close: last,
    date: lastBar.date,
    changePct: c[n - 2] ? Math.round((last / c[n - 2] - 1) * 10_000) / 100 : null,
    rsi14: r[n - 1] != null ? Math.round(r[n - 1] * 10) / 10 : null,
    valueTraded: (lastBar.volume || 0) * last,
    high20: prior20
  };
}

// symbols -> [{ symbol, setups, ... }] for symbols with at least one setup that pass the floor.
export function runScanner(seriesBySymbol, { minValue = 0, minPrice = 0, tf = '1d' } = {}) {
  const hits = [];
  for (const [symbol, byTf] of Object.entries(seriesBySymbol)) {
    const result = scanSetups(byTf?.[tf]);
    if (!result || !result.setups.length) continue;
    if (result.close < minPrice || result.valueTraded < minValue) continue;
    hits.push({ symbol, ...result, labels: result.setups.map((s) => SETUP_LABELS[s]) });
  }
  return hits.sort((a, b) => b.valueTraded - a.valueTraded);
}
