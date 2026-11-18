// Paper test of the gap-rebound entry from scripts/gapResearch.mjs (research
// on 2026-11-17, 36 months, 16 coins): the one gap rule that made money both
// on the train years and on the later test period (+0.11R on 53 trades, then
// +0.36R on 51). The volume threshold was picked after looking at the data,
// so this records live signals first. Nothing here places trades or touches
// the portfolio.
//
// Rule:
// - Gap: a daily 3-candle imbalance after a drop. Day k's high is below day
//   k-2's low, by at least 0.25 ATR, and day k closes red. The gap zone is
//   [high k, low k-2].
// - Capitulation: day k's volume is at least 2x the average of the 20 days
//   before it.
// - Entry, within 10 days and while price is still below the gap, on a closed
//   1h candle: RSI14 was under 30 in the last 24 hours, this is the first close
//   back above the EMA20, and RSI is back above 40. Entry = that close.
// - Stop = lowest low of the last 24 hours - 0.5 ATR, but never more than 15%
//   below the entry. Target = +1.5R from the planned stop. Time stop: 7 days.
//   An hour that touches both stop and target counts as the stop.
// One paper trade per gap, and one open paper trade per coin.
import { TF_MS } from './config.js';

export const GAP_RULE = {
  label: 'Daily gap + 2x volume, 1h RSI/EMA20 rebound',
  minGapAtr: 0.25,
  minGapVolX: 2,
  liveDays: 10,
  maxDays: 7,
  targetR: 1.5,
  maxLossPct: 15
};
const DAY_MS = TF_MS['1d'];
const HOUR_MS = TF_MS['1h'];
// Daily candles re-checked each pass; the 1h history only reaches ~16 days back.
const SCAN_DAYS = 20;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const closeMs = (bar, tf) => bar.time * 1000 + TF_MS[tf];
export const gapKey = (r) => `${r.symbol}|${r.gapTime}`;

function avg(bars, from, to, field) {
  let sum = 0, n = 0;
  for (let m = Math.max(0, from); m <= to; m += 1) { sum += bars[m][field] || 0; n += 1; }
  return n ? sum / n : null;
}

// The gap formed by daily bar k, or null. Uses bars <= k only.
export function gapAt(daily, k, rule = GAP_RULE) {
  if (k < 24) return null;
  const bar = daily[k];
  const atr = daily[k - 1].atr14;
  if (!(atr > 0) || !(bar.close < bar.open)) return null;
  const bottom = bar.high, top = daily[k - 2].low;
  if (!(top - bottom >= rule.minGapAtr * atr)) return null;
  const base = avg(daily, k - 23, k - 4, 'volume');
  const volX = base > 0 ? bar.volume / base : null;
  if (!(volX >= rule.minGapVolX)) return null;
  return { bottom, top, volX };
}

// 1h rebound trigger at bar i (closed bars <= i only).
export function reboundAt(hourly, i) {
  if (i < 25) return false;
  const bar = hourly[i], prev = hourly[i - 1];
  if (bar.rsi14 == null || bar.ema20 == null || prev.ema20 == null || !(bar.atr14 > 0)) return false;
  if (!(bar.close > bar.ema20 && prev.close <= prev.ema20 && bar.rsi14 > 40)) return false;
  for (let m = i - 24; m <= i; m += 1) if (hourly[m].rsi14 != null && hourly[m].rsi14 < 30) return true;
  return false;
}

export function reboundPlan(hourly, i, rule = GAP_RULE) {
  let low = Infinity;
  for (let m = i - 23; m <= i; m += 1) low = Math.min(low, hourly[m].low);
  const entry = hourly[i].close;
  const stop = low - 0.5 * hourly[i].atr14;
  if (!(entry > stop)) return null;
  const exitStop = Math.max(stop, entry * (1 - rule.maxLossPct / 100));
  return { entry, stop, exitStop, target: entry + rule.targetR * (entry - stop) };
}

// Follows a paper trade forward on the 1h candles after entry index i.
export function followGapTrade(hourly, i, plan, rule = GAP_RULE) {
  const maxBars = Math.round(rule.maxDays * DAY_MS / HOUR_MS);
  const last = Math.min(hourly.length - 1, i + maxBars);
  let low = plan.entry, high = plan.entry;
  const done = (status, price, k) => ({ status, exitPrice: price, exitTime: hourly[k].time, barsTracked: k - i, lowSeen: Math.min(low, price), highSeen: high, lastPrice: null });
  for (let k = i + 1; k <= last; k += 1) {
    const bar = hourly[k];
    if (bar.low <= plan.exitStop) {
      low = Math.min(low, plan.exitStop);
      return done(plan.exitStop > plan.stop ? 'maxloss' : 'stop', Math.min(plan.exitStop, bar.open), k);
    }
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
    if (bar.high >= plan.target) return done('target', Math.max(plan.target, bar.open), k);
  }
  if (last === i + maxBars) return done('time', hourly[last].close, last);
  return { status: 'open', exitPrice: null, exitTime: null, barsTracked: last - i, lowSeen: low, highSeen: high, lastPrice: hourly[last].close };
}

const isOpen = (r) => r.status === 'open';

// Adds new gap signals and follows the open ones. Mutates and returns the
// journal, newest entry first. Closed records are never rewritten.
export function updateGapJournal(journal, series, symbols, { rule = GAP_RULE, maxRecords = 500 } = {}) {
  const byKey = new Map(journal.map((r) => [gapKey(r), r]));
  for (const symbol of symbols) {
    const daily = series[symbol]?.['1d'];
    const hourly = series[symbol]?.['1h'];
    if (!daily?.length || !hourly?.length) continue;
    const firstHourMs = hourly[0].time * 1000;
    // Re-follow this coin's open trades.
    for (const record of journal) {
      if (record.symbol !== symbol || !isOpen(record)) continue;
      const i = hourly.findIndex((b) => b.time === record.entryTime);
      if (i < 0) continue;
      Object.assign(record, followGapTrade(hourly, i, record, rule));
    }
    // A coin's newest record blocks new entries until it closed.
    let busyUntilMs = 0;
    for (const record of journal) {
      if (record.symbol !== symbol) continue;
      busyUntilMs = Math.max(busyUntilMs, isOpen(record) ? Infinity : (record.exitTime + 3600) * 1000);
    }
    for (let k = Math.max(24, daily.length - SCAN_DAYS); k < daily.length; k += 1) {
      const gapTime = daily[k].time;
      if (byKey.has(`${symbol}|${gapTime}`)) continue;
      const gap = gapAt(daily, k, rule);
      if (!gap) continue;
      const formedMs = closeMs(daily[k], '1d');
      if (formedMs < firstHourMs + 25 * HOUR_MS) continue; // not enough 1h history to judge it
      const i0 = hourly.findIndex((b) => b.time * 1000 >= formedMs);
      if (i0 < 0) continue;
      const liveBars = Math.round(rule.liveDays * DAY_MS / HOUR_MS);
      for (let i = i0; i < Math.min(hourly.length, i0 + liveBars); i += 1) {
        if (hourly[i].high >= gap.top) break; // filled before any trigger
        if (hourly[i].close >= gap.bottom) continue; // must still be below the gap
        if (closeMs(hourly[i], '1h') < busyUntilMs || !reboundAt(hourly, i)) continue;
        const plan = reboundPlan(hourly, i, rule);
        if (!plan || !(plan.target > plan.entry)) continue;
        const record = {
          symbol, gapTime, gapBottom: gap.bottom, gapTop: gap.top, gapVolX: round(gap.volX),
          entryTime: hourly[i].time, ...plan, taken: false, skip: 'paper test only',
          ...followGapTrade(hourly, i, plan, rule)
        };
        byKey.set(gapKey(record), record);
        journal.push(record);
        busyUntilMs = isOpen(record) ? Infinity : (record.exitTime + 3600) * 1000;
        break; // one trade per gap
      }
    }
  }
  journal.sort((a, b) => b.entryTime - a.entryTime);
  return journal.slice(0, maxRecords);
}

// Result in R and % after costs; null while open.
export function gapResult(record, costPct) {
  if (isOpen(record) || record.exitPrice == null) return null;
  const risk = record.entry - record.stop;
  return {
    r: round((record.exitPrice - record.entry) / risk - (record.entry * costPct / 100) / risk),
    pct: round((record.exitPrice / record.entry - 1) * 100 - costPct)
  };
}

export function summarizeGap(journal, { costPct }) {
  const results = journal.map((r) => gapResult(r, costPct)).filter(Boolean);
  const n = results.length;
  const totalR = results.reduce((s, x) => s + x.r, 0);
  return {
    label: GAP_RULE.label,
    rule: GAP_RULE,
    costPct,
    since: journal.length ? new Date(journal.at(-1).entryTime * 1000).toISOString() : null,
    signals: journal.length,
    open: journal.filter(isOpen).length,
    closed: n,
    winPct: n ? round(results.filter((x) => x.r > 0).length / n * 100) : null,
    avgR: n ? round(totalR / n) : null,
    totalR: round(totalR),
    avgPct: n ? round(results.reduce((s, x) => s + x.pct, 0) / n) : null
  };
}
