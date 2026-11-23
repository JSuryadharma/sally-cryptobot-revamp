// Extra read-outs computed on every pass, for both markets, from the candles
// already loaded: the daily setup scanner (tools/scanner.js) and the
// time-machine odds (tools/timeMachine.js) for open positions and for the
// next breakout each watched symbol could trigger. Nothing here trades.
import { profilesFor, profileTargetR, profileTimeStopBars } from './config.js';
import { normalizePosition } from './ledger.js';
import { runScanner } from '../tools/scanner.js';
import { timeMachine } from '../tools/timeMachine.js';

function round(v, d = 2) { return Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null; }

// Odds for each open position from its current price to its stop and target.
export function positionOdds({ positions, series, live, cfg }) {
  const odds = {};
  for (const [symbol, raw] of Object.entries(positions || {})) {
    const p = normalizePosition(raw);
    const profile = profilesFor(cfg)[p.profile];
    const daily = series[symbol]?.['1d'];
    if (!profile || !daily) continue;
    const risk = p.entryPrice - p.initialStop;
    const target = p.targetPrice ?? (profileTargetR(profile, cfg) && risk > 0 ? p.entryPrice + profileTargetR(profile, cfg) * risk : null);
    const price = live?.[symbol]?.['1d']?.close ?? daily.at(-1).close;
    const tfDays = profile.triggerTf === '1d' ? 1 : profile.triggerTf === '1h' ? 1 / 24 : profile.triggerTf === '4h' ? 1 / 6 : 1 / 96;
    const daysLeft = Math.max(1, Math.round((profileTimeStopBars(profile, cfg) - (p.barsHeld || 0)) * tfDays));
    if (!target) continue;
    const tm = timeMachine({ daily, price, stop: p.stopPrice, target, horizonDays: daysLeft });
    if (tm) odds[symbol] = { ...tm, price, stop: p.stopPrice, target: round(target, 8) };
  }
  return odds;
}

// The breakout plan each symbol would trade next (buy at the prior N-day high,
// the profile's ATR stop and R target) and its odds, so the radar can say how
// good a trade it would be, not only how close it is.
export function breakoutPlans({ symbols, series, live, cfg, profileKey }) {
  const profile = profilesFor(cfg)[profileKey];
  const plans = {};
  if (!profile?.breakoutLookback) return plans;
  for (const symbol of symbols) {
    const daily = series[symbol]?.[profile.triggerTf];
    if (!daily || daily.length < profile.breakoutLookback + 20) continue;
    const last = daily.at(-1);
    let level = -Infinity;
    for (let k = daily.length - profile.breakoutLookback; k < daily.length; k += 1) level = Math.max(level, daily[k].high);
    if (!(last.atr14 > 0)) continue;
    const stop = level - profile.stopAtr * last.atr14;
    const target = level + profileTargetR(profile, cfg) * (level - stop);
    const price = live?.[symbol]?.[profile.triggerTf]?.close ?? last.close;
    const tm = timeMachine({ daily, price: level, stop, target, horizonDays: profileTimeStopBars(profile, cfg) });
    plans[symbol] = {
      profile: profileKey, level: round(level, 8), stop: round(stop, 8), target: round(target, 8),
      distancePct: round(((level - price) / price) * 100), odds: tm
    };
  }
  return plans;
}

export function scannerFor(series, { minValue = 0, minPrice = 0 } = {}) {
  return runScanner(series, { minValue, minPrice });
}
