// Paper test of the daily breakout entry from the entry research
// (scripts/entryResearch.mjs on the research branch): the only rules that made
// money both on the data they were tuned on and on the later test period.
// Nothing here places trades or touches the portfolio. Each signal becomes a
// record in the same format as the live signal journal (outcomes.js) and is
// followed forward the same way, then scored as if it had been traded with
// the research's exits: a 2x ATR stop, a fixed R target, a 30-day time stop.
//
// Rules, evaluated on each closed daily candle:
// - BTC's daily close is above its 200-day average, and
// - the coin closes above the highest high of the previous 20 (or 55) days.
// One paper trade per coin per rule at a time, as in the research.
import { BTC_SYMBOL, TF_MS } from './config.js';
import { trackOutcome, updateJournal, indexOfTime, recordKey, summarizeOutcomes } from './outcomes.js';

export const PAPER_RULES = [
  { key: 'breakout20', label: '20-day high breakout', lookback: 20, targetR: 1 },
  { key: 'breakout55', label: '55-day high breakout', lookback: 55, targetR: 2 }
];
export const PAPER_TF = '1d';
export const PAPER_STOP_ATR = 2;
export const PAPER_MAX_BARS = 30;
const BTC_SMA_DAYS = 200;
// Recent closed daily candles checked each pass, so a missed day is caught up.
const LIVE_SCAN_BARS = 3;

function round2(v) { return Math.round(v * 100) / 100; }

// Is BTC's latest daily close at or before `time` above its 200-day average?
export function btcAbove200d(btcDaily, time) {
  if (!btcDaily?.length) return false;
  let j = btcDaily.length - 1;
  while (j >= 0 && btcDaily[j].time > time) j -= 1;
  if (j < BTC_SMA_DAYS - 1) return false;
  let sum = 0;
  for (let k = j - BTC_SMA_DAYS + 1; k <= j; k += 1) sum += btcDaily[k].close;
  return btcDaily[j].close > sum / BTC_SMA_DAYS;
}

// Entry plan if daily bar i breaks out under `rule`, else null. Uses bars <= i only.
export function breakoutPlan(daily, i, rule, btcDaily) {
  const bar = daily[i];
  if (i < rule.lookback || !(bar.atr14 > 0)) return null;
  let priorHigh = -Infinity;
  for (let k = i - rule.lookback; k < i; k += 1) priorHigh = Math.max(priorHigh, daily[k].high);
  if (!(bar.close > priorHigh)) return null;
  if (!btcAbove200d(btcDaily, bar.time)) return null;
  return { entry: bar.close, stop: bar.close - PAPER_STOP_ATR * bar.atr14, breakoutLevel: priorHigh };
}

// Index of the daily bar where the paper trade closed: the first bar that
// reached the target (the journal keeps following to +2R, a paper trade stops
// there), otherwise the stop or time stop. Infinity while still open.
function paperExitIndex(record, daily) {
  const start = indexOfTime(daily, record.barTime);
  if (start < 0) return -1;
  if (record.mfeR >= record.targetR) {
    const target = record.entry + record.targetR * (record.entry - record.stop);
    for (let k = start + 1; k < daily.length; k += 1) if (daily[k].high >= target) return k;
  }
  return record.status === 'pending' ? Infinity : start + record.barsTracked;
}

// True while the coin's previous paper trade under this rule is still open at bar i.
function busyAt(journal, symbol, rule, daily, i) {
  const last = journal.find((r) => r.symbol === symbol && r.profile === rule.key && r.barTime < daily[i].time);
  return Boolean(last) && i <= paperExitIndex(last, daily);
}

// Adds new breakout signals per symbol, oldest first, and follows every
// pending record forward. Mutates and returns the journal (newest first).
// Without a window it scans the last few closed daily candles, which is what
// the live tick does; the backtest passes { startMs, endMs } to replay history.
export function updatePaperJournal(journal, series, symbols, { window = null, maxRecords = 2000 } = {}) {
  const btcDaily = series[BTC_SYMBOL]?.[PAPER_TF];
  const seen = new Set(journal.map(recordKey));
  const closeMs = (bar) => bar.time * 1000 + TF_MS[PAPER_TF];
  for (const symbol of symbols) {
    const daily = series[symbol]?.[PAPER_TF];
    if (!daily?.length) continue;
    let from = daily.length - LIVE_SCAN_BARS;
    let to = daily.length - 1;
    if (window) {
      from = daily.findIndex((b) => closeMs(b) >= window.startMs);
      if (from < 0) continue;
      while (to >= 0 && closeMs(daily[to]) >= window.endMs) to -= 1;
    }
    from = Math.max(1, from);
    for (let i = from; i <= to; i += 1) {
      for (const rule of PAPER_RULES) {
        const record = { symbol, profile: rule.key, barTime: daily[i].time };
        if (seen.has(recordKey(record)) || busyAt(journal, symbol, rule, daily, i)) continue;
        const plan = breakoutPlan(daily, i, rule, btcDaily);
        if (!plan) continue;
        Object.assign(record, {
          setup: rule.key, tf: PAPER_TF, score: null, entry: plan.entry, stop: plan.stop,
          breakoutLevel: plan.breakoutLevel, targetR: rule.targetR, taken: false, skip: 'paper test only',
          maxBars: PAPER_MAX_BARS, status: 'pending', mfeR: 0, barsTracked: 0
        });
        Object.assign(record, trackOutcome(daily, i + 1, { entry: record.entry, stop: record.stop, maxBars: record.maxBars }));
        seen.add(recordKey(record));
        const at = journal.findIndex((r) => r.barTime < record.barTime);
        journal.splice(at < 0 ? journal.length : at, 0, record);
      }
    }
  }
  return updateJournal(journal, [], series, { maxRecords });
}

// The paper trade's result in R after costs, or null while it is still open:
// the target once price reached it before the stop, otherwise where the stop
// or the time stop closed it.
export function paperR(record, costPct) {
  const risk = record.entry - record.stop;
  const costR = (record.entry * costPct / 100) / risk;
  if (record.mfeR >= record.targetR) return round2(record.targetR - costR);
  if (record.status === 'pending' || record.exitR == null) return null;
  return round2(record.exitR - costR);
}

function resultStats(rs) {
  const n = rs.length;
  if (!n) return { closed: 0, winPct: null, avgR: null, totalR: 0 };
  const total = rs.reduce((s, v) => s + v, 0);
  return { closed: n, winPct: round2((rs.filter((v) => v > 0).length / n) * 100), avgR: round2(total / n), totalR: round2(total) };
}

// Per-rule summary for the dashboard and the backtest report. costPct is the
// full round trip including slippage, charged in R.
export function summarizePaper(journal, { costPct }) {
  return {
    costPct,
    since: journal.length ? new Date(journal.at(-1).barTime * 1000).toISOString() : null,
    rules: PAPER_RULES.map((rule) => {
      const records = journal.filter((r) => r.profile === rule.key);
      const results = records.map((r) => paperR(r, costPct)).filter((v) => v != null);
      return {
        key: rule.key, label: rule.label, targetR: rule.targetR,
        signals: records.length,
        open: records.length - results.length,
        ...resultStats(results),
        hitRate: summarizeOutcomes(records, { levels: [rule.targetR] }).levels[`${rule.targetR}R`].overall
      };
    })
  };
}

export function paperCostPct(cfg) {
  return round2(cfg.roundTripCostPct + 2 * cfg.slippagePct);
}
