// "Time machine": odds that a trade reaches its target before its stop,
// ported from day-trader-skill's trader-timemachine (timemachine.py) and
// adapted from 5-minute intraday bars to daily candles.
//
// The skill replays a plan thousands of times by stitching together real past
// bars as ratios to the previous close. Here: every past daily candle of the
// asset becomes (open, high, low, close) / previous close. Each replay starts
// at the current price, draws a random past day per step, checks the stop
// before the target inside each day (conservative, as in the skill) and stops
// after `horizonDays` (the strategy's time stop).
//
// Verdict, as in the skill: share = target hits / (target + stop hits),
// break-even share = 1 / (1 + R), edge = share - break-even:
// |edge| < 0.05 "coin flip" (at 1R) / "break-even", 0.05-0.15 "leans", >= 0.15 "strongly".
// Uses a seeded generator so the same inputs give the same numbers.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ratioPool(daily, maxDays = 365) {
  const bars = (daily || []).slice(-(maxDays + 1));
  const pool = [];
  for (let k = 1; k < bars.length; k += 1) {
    const prev = bars[k - 1].close;
    const b = bars[k];
    if (!(prev > 0) || ![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    pool.push([b.open / prev, b.high / prev, b.low / prev, b.close / prev]);
  }
  return pool;
}

function verdictOf(share, rNow) {
  if (share == null) return { edge: null, label: 'no data' };
  const even = 1 / (1 + rNow);
  const d = share - even;
  const abs = Math.abs(d);
  const dir = d > 0 ? 'target' : 'stop';
  let label;
  if (abs < 0.05) label = Math.abs(rNow - 1) < 0.05 ? 'coin flip' : 'break-even';
  else if (abs < 0.15) label = `leans ${dir}`;
  else label = `strongly ${dir}`;
  return { edge: Math.round(d * 1000) / 1000, breakEven: Math.round(even * 1000) / 1000, label };
}

// price: where the replay starts (current price, or the planned entry).
export function timeMachine({ daily, price, stop, target, horizonDays = 30, paths = 2000, seed = 19 }) {
  if (!(price > stop) || !(target > price) || !(stop > 0)) return null;
  const pool = ratioPool(daily);
  if (pool.length < 60) return null;
  const rand = mulberry32(seed);
  let hitTarget = 0;
  let hitStop = 0;
  let daysSum = 0;
  for (let n = 0; n < paths; n += 1) {
    let p = price;
    for (let day = 1; day <= horizonDays; day += 1) {
      const [o, h, l, c] = pool[Math.floor(rand() * pool.length)];
      // A day that opens through a level fills there first.
      if (p * o <= stop || p * l <= stop) { hitStop += 1; daysSum += day; break; }
      if (p * h >= target) { hitTarget += 1; daysSum += day; break; }
      p *= c;
    }
  }
  const decided = hitTarget + hitStop;
  const share = decided ? hitTarget / decided : null;
  const rNow = (target - price) / (price - stop);
  return {
    paths, horizonDays, poolDays: pool.length,
    pTarget: Math.round((hitTarget / paths) * 1000) / 1000,
    pStop: Math.round((hitStop / paths) * 1000) / 1000,
    pNeither: Math.round(((paths - decided) / paths) * 1000) / 1000,
    share: share == null ? null : Math.round(share * 1000) / 1000,
    rewardRisk: Math.round(rNow * 100) / 100,
    avgDaysToExit: decided ? Math.round((daysSum / decided) * 10) / 10 : null,
    ...verdictOf(share, rNow)
  };
}
