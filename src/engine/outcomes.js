// Prediction accuracy. Every setup the engine flags is a prediction: "price
// reaches +1R before it hits the stop". This module follows each one forward
// over later candles, whether or not a trade was placed, and summarises how
// often the prediction came true by score. Pure: used by the live tick's
// signal journal and by the backtester.
import { profilesFor, profileTimeStopBars } from './config.js';

// R levels reported on. A signal counts as a hit at level T once it reaches
// +T R before the stop.
export const OUTCOME_LEVELS = [1, 2];
// Follow a signal until the stop, this many R, or the profile's time stop.
const MAX_TRACK_R = Math.max(...OUTCOME_LEVELS);
export const SCORE_BUCKETS = [[0, 39], [40, 49], [50, 59], [60, 69], [70, 100]];

function round2(v) { return Math.round(v * 100) / 100; }

// Follows one signal over bars[fromIndex..]. bars[fromIndex] is the first
// candle after the signal candle. Within one candle the stop is checked first,
// matching positionManager's pessimistic ordering.
// Returns { status: 'pending'|'stopped'|'target'|'expired', mfeR, barsTracked }.
export function trackOutcome(bars, fromIndex, { entry, stop, maxBars, prior = null }) {
  const risk = entry - stop;
  if (!(risk > 0)) return { status: 'invalid', mfeR: 0, barsTracked: 0 };
  let mfeR = prior?.mfeR ?? 0;
  let barsTracked = prior?.barsTracked ?? 0;
  for (let k = fromIndex; k < bars.length; k += 1) {
    const bar = bars[k];
    barsTracked += 1;
    if (bar.low <= stop) return { status: 'stopped', mfeR: round2(mfeR), barsTracked };
    mfeR = Math.max(mfeR, (bar.high - entry) / risk);
    if (mfeR >= MAX_TRACK_R) return { status: 'target', mfeR: round2(mfeR), barsTracked };
    if (barsTracked >= maxBars) return { status: 'expired', mfeR: round2(mfeR), barsTracked };
  }
  return { status: 'pending', mfeR: round2(mfeR), barsTracked };
}

export function maxBarsFor(profileKey, cfg) {
  const profile = profilesFor(cfg)[profileKey];
  return profile ? profileTimeStopBars(profile, cfg) : 54;
}

// Index of the bar with open time `time`, or -1.
function indexOfTime(bars, time) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time === time) return mid;
    if (bars[mid].time < time) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// Hit / miss / undecided for one record at level T.
export function outcomeAt(record, level) {
  if (record.mfeR >= level) return 'hit';
  if (record.status === 'pending') return 'open';
  return 'miss';
}

export function recordKey(r) {
  return `${r.symbol}|${r.profile}|${r.barTime}`;
}

// Builds journal records from advance()'s out.signals. Signals without a
// price plan (e.g. rejected before a stop was placed) are ignored.
export function signalRecords(signals, cfg) {
  const records = [];
  for (const s of signals) {
    if (!(s.entryPrice > s.stopPrice) || !s.tf) continue;
    records.push({
      symbol: s.symbol, profile: s.profile, setup: s.setup, tf: s.tf, barTime: s.barTime,
      score: s.score, entry: s.entryPrice, stop: s.stopPrice, taken: Boolean(s.taken), skip: s.skip ?? null,
      maxBars: maxBarsFor(s.profile, cfg), status: 'pending', mfeR: 0, barsTracked: 0
    });
  }
  return records;
}

// Adds new records and moves every pending one forward using `series`.
// Mutates and returns the journal array (newest first), capped at maxRecords.
export function updateJournal(journal, newRecords, series, { maxRecords = 3000 } = {}) {
  const seen = new Set(journal.map(recordKey));
  for (const r of newRecords) {
    if (seen.has(recordKey(r))) continue;
    seen.add(recordKey(r));
    journal.unshift(r);
  }
  for (const r of journal) {
    if (r.status !== 'pending') continue;
    const bars = series[r.symbol]?.[r.tf];
    if (!bars?.length) continue;
    const signalIndex = indexOfTime(bars, r.barTime);
    if (signalIndex < 0) {
      // Older than the loaded window: it can no longer be followed.
      if (bars[0].time > r.barTime) r.status = 'expired';
      continue;
    }
    const from = signalIndex + 1 + r.barsTracked;
    Object.assign(r, trackOutcome(bars, from, { entry: r.entry, stop: r.stop, maxBars: r.maxBars, prior: r }));
  }
  if (journal.length > maxRecords) journal.length = maxRecords;
  return journal;
}

function hitStats(records, level) {
  let hits = 0;
  let decided = 0;
  for (const r of records) {
    const o = outcomeAt(r, level);
    if (o === 'open') continue;
    decided += 1;
    if (o === 'hit') hits += 1;
  }
  return { decided, hits, hitRatePct: decided ? round2((hits / decided) * 100) : null };
}

// Probability that a random hit scored higher than a random miss (ties count
// half). 50 = the score carries no information, 100 = it separates perfectly.
export function scoreAuc(records, level) {
  const hits = [];
  const misses = [];
  for (const r of records) {
    if (!Number.isFinite(r.score)) continue;
    const o = outcomeAt(r, level);
    if (o === 'hit') hits.push(r.score); else if (o === 'miss') misses.push(r.score);
  }
  if (!hits.length || !misses.length) return null;
  let wins = 0;
  for (const h of hits) for (const m of misses) wins += h > m ? 1 : h === m ? 0.5 : 0;
  return round2((wins / (hits.length * misses.length)) * 100);
}

function bucketLabel([lo, hi]) { return hi >= 100 ? `${lo}+` : `${lo}-${hi}`; }

// Summary for the dashboard and the backtest report.
export function summarizeOutcomes(records, { levels = OUTCOME_LEVELS } = {}) {
  const summary = {
    signals: records.length,
    taken: records.filter((r) => r.taken).length,
    pending: records.filter((r) => r.status === 'pending').length,
    levels: {}
  };
  for (const level of levels) {
    const key = `${level}R`;
    summary.levels[key] = {
      overall: hitStats(records, level),
      taken: hitStats(records.filter((r) => r.taken), level),
      skipped: hitStats(records.filter((r) => !r.taken), level),
      scoreAucPct: scoreAuc(records, level),
      byScore: SCORE_BUCKETS.map((b) => ({ bucket: bucketLabel(b), ...hitStats(records.filter((r) => r.score >= b[0] && r.score <= b[1]), level) })),
      byProfile: Object.fromEntries([...new Set(records.map((r) => r.profile))].map((p) => [p, hitStats(records.filter((r) => r.profile === p), level)]))
    };
  }
  return summary;
}
