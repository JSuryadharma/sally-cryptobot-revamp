// Order list for manual execution (Joe, 2026-11-21): what to buy now, which
// buy orders to prepare, and the sell plan (target, stop-loss, time limit) of
// every open position, sized with the robot's own risk rules. IDX prices are
// rounded to the IDX tick table and sizes to whole lots of 100 shares.
import { profilesFor, profileTargetR, profileTimeStopBars } from './config.js';

const DAY_MS = 86_400_000;

// IDX price fractions (BEI): < 200: 1, < 500: 2, < 2,000: 5, < 5,000: 10, else 25.
export function idxTick(price) {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}
export function roundIdx(price, dir = 'nearest') {
  const t = idxTick(price);
  const f = dir === 'up' ? Math.ceil : dir === 'down' ? Math.floor : Math.round;
  return f(price / t - 1e-9 * (dir === 'up' ? 1 : -1)) * t;
}
const r6 = (v) => (v == null ? null : Number(Number(v).toPrecision(6)));

/**
 * market: 'idx' | 'crypto'. plans: breakoutPlans() output. prices: symbol -> last price.
 * positions: open positions of that market. allowed(symbol) -> market filter passes.
 * equityIdr / cashIdr: shared account. usdIdrRate converts crypto sizes.
 */
export function buildOrderList({ market, plans = {}, prices = {}, positions = {}, cfg, equityIdr, cashIdr, usdIdrRate = 1, allowed = () => true, nowMs = Date.now(), watchPct = 8, chaseAtr = 0.75 }) {
  const idx = market === 'idx';
  const roundBuy = (p) => (idx ? roundIdx(p, 'up') : r6(p));
  const roundSell = (p) => (idx ? roundIdx(p, 'down') : r6(p));
  const riskIdr = equityIdr * (cfg.riskPerTradePct / 100);
  const capIdr = Math.min(equityIdr * (cfg.tradeAllocationPct ?? 0.3), Math.max(0, cashIdr));
  const priceIdr = (p) => (idx ? p : p * usdIdrRate);
  const size = (entry, stop) => {
    const perUnitRiskIdr = priceIdr(entry - stop);
    if (!(perUnitRiskIdr > 0)) return null;
    let units = Math.min(riskIdr / perUnitRiskIdr, capIdr / priceIdr(entry));
    if (idx) { const lots = Math.floor(units / 100); return lots > 0 ? { lots, shares: lots * 100, valueIdr: Math.round(lots * 100 * entry), riskIdr: Math.round(lots * 100 * (entry - stop)) } : null; }
    units = Number(units.toPrecision(4));
    return units > 0 ? { units, valueIdr: Math.round(units * priceIdr(entry)), valueUsdt: Math.round(units * entry * 100) / 100, riskIdr: Math.round(units * perUnitRiskIdr) } : null;
  };

  const held = new Set(Object.keys(positions));
  const buyNow = [];
  const prepare = [];
  for (const [symbol, plan] of Object.entries(plans)) {
    if (held.has(symbol) || !(plan?.level > 0) || !(plan.stop > 0)) continue;
    const price = prices[symbol];
    if (!(price > 0) || !allowed(symbol)) continue;
    const profile = profilesFor(cfg)[plan.profile] || {};
    const atr = profile.stopAtr ? (plan.level - plan.stop) / profile.stopAtr : null;
    const odds = plan.odds ? { pTarget: plan.odds.pTarget, pStop: plan.odds.pStop, verdict: plan.odds.verdict ?? null } : null;
    if (price >= plan.level) {
      // Broken out: still worth buying while price is within chaseAtr ATR of the level.
      if (atr && price > plan.level + chaseAtr * atr) continue;
      const entry = roundBuy(price);
      const stop = roundSell(entry - (plan.level - plan.stop));
      const target = roundSell(entry + profileTargetR(profile, cfg) * (entry - stop));
      const maxEntry = atr ? roundBuy(plan.level + chaseAtr * atr) : entry;
      const sz = size(entry, stop);
      if (sz) buyNow.push({ symbol, action: 'BUY_NOW', entry, maxEntry, stop, target, level: plan.level, price, ...sz, odds });
    } else if (plan.distancePct <= watchPct) {
      const entry = roundBuy(plan.level * 1.001);
      const stop = roundSell(plan.stop);
      const target = roundSell(entry + profileTargetR(profile, cfg) * (entry - stop));
      const sz = size(entry, stop);
      if (sz) prepare.push({ symbol, action: 'BUY_IF_BREAK', entry, stop, target, level: plan.level, price, distancePct: plan.distancePct, ...sz, odds });
    }
  }
  prepare.sort((a, b) => a.distancePct - b.distancePct);

  const sell = Object.values(positions).map((p) => {
    const profile = profilesFor(cfg)[p.profile] || {};
    const riskPerUnit = (p.entryPrice - (p.initialStop ?? p.stopPrice));
    const targetR = profileTargetR(profile, cfg);
    const target = p.targetPrice ?? (targetR && riskPerUnit > 0 ? p.entryPrice + targetR * riskPerUnit : null);
    const bars = profileTimeStopBars(profile, cfg);
    const price = prices[p.symbol] ?? null;
    return {
      symbol: p.symbol, action: 'HOLD', entry: r6(p.entryPrice), price,
      stop: roundSell(p.stopPrice), target: target ? roundSell(target) : null,
      sellBy: bars && p.openedAt ? new Date(Date.parse(p.openedAt) + bars * DAY_MS).toISOString().slice(0, 10) : null,
      changePct: price ? Math.round((price / p.entryPrice - 1) * 1000) / 10 : null,
      ...(idx ? { lots: Math.floor(p.quantity / 100) } : { units: r6(p.quantity) })
    };
  });

  return { updatedAt: new Date(nowMs).toISOString(), market, buyNow, prepare: prepare.slice(0, 10), sell, riskPerTradePct: cfg.riskPerTradePct };
}
