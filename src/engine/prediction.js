// "When will the robot fire?" - pure prediction built from the same
// evaluateSetup() the engine trades on. The still-forming candle is judged as
// if it closed right now, which is exactly the check the engine will run when
// that candle actually closes.
import { profilesFor, profileTargetR, profileTimeStopMinR, TF_MS, BTC_SYMBOL } from './config.js';
import { evaluateSetup, placeStop } from './setups.js';
import { sizePosition } from './sizing.js';
import { entryBlock } from './riskGuard.js';
import { normalizePosition } from './ledger.js';

export const STAGE_RANK = { blocked: 0, watching: 1, 'setting-up': 2, ready: 3, holding: 4 };
// Checklist per entry type: market gates first, then the setup itself.
const SPECS = {
  pullback: { gates: ['htfTrend', 'btcGate', 'tradeable'], conditions: ['htfTrend', 'btcGate', 'tradeable', 'tfTrend', 'pullback', 'reclaim', 'noChase'] },
  breakout: { gates: ['btcRegime', 'tradeable'], conditions: ['btcRegime', 'tradeable', 'breakout'] }
};
const GATE_KEYS = [...new Set(Object.values(SPECS).flatMap((spec) => spec.gates))];
const specFor = (profile) => SPECS[profile.entry] || SPECS.pullback;
const TF_NAME = { '5m': '5-minute', '15m': '15-minute', '1h': '1-hour', '4h': '4-hour', '1d': 'daily' };

function roundPrice(v) { return Number.isFinite(v) && v !== 0 ? Number(v.toPrecision(8)) : v; }
function round2(v) { return Math.round(v * 100) / 100; }

function conditionText(key, profile) {
  const trig = TF_NAME[profile.triggerTf];
  const filt = TF_NAME[profile.filterTf];
  return {
    htfTrend: { label: `${filt[0].toUpperCase()}${filt.slice(1)} trend is up`, fail: `the ${filt} trend is not up` },
    btcGate: { label: `Bitcoin is above its ${filt} EMA50`, fail: 'Bitcoin is below its EMA50' },
    tradeable: { label: 'Enough volume and price movement', fail: 'volume or movement is too low' },
    tfTrend: { label: `${trig[0].toUpperCase()}${trig.slice(1)} chart is in an uptrend`, fail: `the ${trig} chart is not in an uptrend` },
    pullback: { label: 'Price pulled back to the EMA20 in the last 5 candles', fail: 'no recent pullback to the EMA20' },
    reclaim: { label: `This ${trig} candle closes above the previous high`, fail: 'the candle has not closed above the previous high' },
    noChase: { label: 'Not overextended (close near the EMA20)', fail: 'price is stretched too far above the EMA20' },
    btcRegime: { label: 'Bitcoin is above its 200-day average', fail: 'Bitcoin is below its 200-day average' },
    breakout: {
      label: `This ${trig} candle closes above the prior ${profile.breakoutLookback}-day high`,
      fail: `price has not closed above the ${profile.breakoutLookback}-day high`
    }
  }[key];
}

function formatTime(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC';
  }
}

// Last candle index (<= i) whose low reached the EMA20 pullback zone.
function lastTouchIndex(trig, i, cfg) {
  const p = cfg.setup;
  for (let k = i; k >= Math.max(0, i - p.pullbackLookback); k -= 1) {
    const b = trig[k];
    if (b && Number.isFinite(b.atr14) && b.low <= b.ema20 + p.pullbackTouchAtr * b.atr14) return k;
  }
  return null;
}

function profilePrediction({ symbol, profile, series, live, cfg, portfolio, risk, symbolState, autoTradeOn, usdIdrRate, nowMs }) {
  const closed = series[symbol]?.[profile.triggerTf];
  const forming = live[symbol]?.[profile.triggerTf];
  const filt = series[symbol]?.[profile.filterTf];
  if (!closed?.length || !forming || !filt?.length) return null;

  const trig = closed.concat(forming);
  const i = trig.length - 1;
  const btcFilt = series[BTC_SYMBOL]?.[profile.filterTf];
  const ctx = { filt, j: filt.length - 1, profile, cfg, btc: btcFilt ? { filt: btcFilt, j: btcFilt.length - 1 } : null };
  const evaluation = evaluateSetup({ ...ctx, trig, i });
  // Market gates (trend, BTC, volume) come from closed candles: a forming
  // candle's volume only covers part of its period, which would under-read a
  // daily candle's 24h volume for most of the day.
  const closedEvaluation = evaluateSetup({ ...ctx, trig: closed, i: closed.length - 1 });

  const spec = specFor(profile);
  const isBreakout = profile.entry === 'breakout';
  const byKey = Object.fromEntries(evaluation.checklist.map((c) => [c.key, c]));
  for (const c of closedEvaluation.checklist) if (spec.gates.includes(c.key)) byKey[c.key] = c;
  const conditions = spec.conditions.map((key) => {
    const text = conditionText(key, profile);
    if (key === 'btcGate' && !cfg.btcGate) return { key, label: text.label, ok: true, na: true, detail: 'not used' };
    const item = byKey[key];
    return { key, label: text.label, ok: Boolean(item?.ok), detail: item?.detail || 'not enough data yet', failText: text.fail };
  });
  const counted = conditions.filter((c) => !c.na);
  const met = counted.filter((c) => c.ok).length;
  const ok = (key) => conditions.find((c) => c.key === key)?.ok;

  const prev = closed.at(-1);
  const price = forming.close;
  const atr = forming.atr14;
  let triggerPrice = roundPrice(prev.high);
  if (isBreakout) {
    let high = -Infinity;
    for (let k = Math.max(0, i - profile.breakoutLookback); k < i; k += 1) high = Math.max(high, trig[k].high);
    triggerPrice = roundPrice(high);
  }
  const chaseCeiling = !isBreakout && Number.isFinite(forming.ema20) && Number.isFinite(atr) ? roundPrice(forming.ema20 + cfg.setup.chaseMaxAtr * atr) : null;

  let stage;
  if (!spec.gates.every(ok)) stage = 'blocked';
  else if (isBreakout) {
    // Setting up once price is within one ATR of the breakout level.
    stage = ok('breakout') ? 'ready' : Number.isFinite(atr) && price >= triggerPrice - atr ? 'setting-up' : 'watching';
  } else if (ok('tfTrend') && ok('pullback')) stage = ok('reclaim') && ok('noChase') ? 'ready' : 'setting-up';
  else stage = 'watching';
  const decisionAt = forming.time * 1000 + TF_MS[profile.triggerTf];

  const touch = isBreakout ? null : lastTouchIndex(trig, i - 1, cfg);
  const pullbackValidFor = ok('pullback') && touch != null ? Math.max(0, touch + cfg.setup.pullbackLookback - (i - 1)) : 0;

  let plan = null;
  if (stage === 'setting-up' || stage === 'ready') {
    const entry = evaluation.signal ? evaluation.signal.entryPrice : Math.max(triggerPrice, price);
    let stop = evaluation.signal?.stopPrice ?? null;
    if (stop == null && isBreakout && Number.isFinite(atr) && atr > 0) stop = roundPrice(entry - profile.stopAtr * atr);
    if (stop == null && Number.isFinite(atr) && atr > 0) {
      let swingLow = forming.low;
      for (let k = i - cfg.setup.pullbackLookback; k < i; k += 1) if (trig[k]) swingLow = Math.min(swingLow, trig[k].low);
      stop = placeStop(entry, swingLow - cfg.setup.stopBufferAtr * atr, atr, cfg).stop;
    }
    if (stop != null && stop < entry) {
      const fill = entry * (1 + cfg.slippagePct / 100);
      const sized = sizePosition({ portfolio, entryPrice: fill, stopPrice: stop, usdIdrRate, cfg });
      plan = {
        entryPrice: roundPrice(fill), stopPrice: stop,
        stopDistancePct: round2(((fill - stop) / fill) * 100),
        positionIdr: sized.qty > 0 ? Math.round(sized.qty * fill * usdIdrRate) : 0,
        riskIdr: sized.qty > 0 ? Math.round(sized.riskIdr) : 0,
        sizingNote: sized.qty > 0 ? null : sized.reason
      };
    }
  }

  const blockers = [];
  if (!autoTradeOn) blockers.push('Auto-trade is off, so the robot only watches.');
  const pause = entryBlock(risk, nowMs, cfg);
  if (pause) blockers.push(`New entries are paused: ${pause}.`);
  if (Object.keys(portfolio.positions || {}).length >= cfg.maxOpenPositions) blockers.push(`All ${cfg.maxOpenPositions} position slots are in use.`);
  const cooldownUntil = symbolState?.cooldownUntilMs?.[profile.key];
  if (cooldownUntil && nowMs < cooldownUntil) blockers.push(`Cooling down after ${profile.cooldownAfterAnyExit ? 'the last trade' : 'a stop-out'} until ${formatTime(cooldownUntil, cfg.timeZone)}.`);
  if (plan?.sizingNote) blockers.push(`Can't size a position: ${plan.sizingNote}.`);

  return {
    profile: profile.key,
    profileLabel: profile.label,
    entry: profile.entry || 'pullback',
    timeframe: profile.triggerTf,
    stage,
    conditions,
    met,
    total: counted.length,
    trigger: {
      price: triggerPrice,
      chaseCeiling,
      livePrice: roundPrice(price),
      distancePct: round2(((triggerPrice - price) / price) * 100),
      distanceAtr: Number.isFinite(atr) && atr > 0 ? round2((triggerPrice - price) / atr) : null
    },
    decisionAt,
    decisionLabel: formatTime(decisionAt, cfg.timeZone),
    pullbackValidFor,
    score: evaluation.signal?.score ?? null,
    plan,
    blockers,
    canFire: blockers.length === 0
  };
}

function exitPrediction({ position: raw, series, live, cfg, nowMs }) {
  const position = normalizePosition(raw);
  const profile = profilesFor(cfg)[position.profile];
  if (!profile) return null;
  const forming = live[position.symbol]?.[profile.triggerTf];
  const price = forming?.close ?? position.entryPrice;
  const riskPerUnit = position.entryPrice - position.initialStop;
  const tfMs = TF_MS[profile.triggerTf];
  const stopKind = position.stopPrice > position.entryPrice * (1 + cfg.roundTripCostPct / 100) ? 'trailing'
    : position.stopPrice >= position.entryPrice ? 'breakeven' : 'initial';
  const timeStopActive = (position.mfeR ?? 0) < profileTimeStopMinR(profile, cfg) && Number.isFinite(position.openedBarTime);
  const targetR = profileTargetR(profile, cfg);
  const timeStopBars = Math.round(profile.timeStopBars * (cfg.timeStopMult ?? 1));
  return {
    profile: profile.key,
    profileLabel: profile.label,
    timeframe: profile.triggerTf,
    stage: 'holding',
    livePrice: roundPrice(price),
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    stopKind,
    distanceToStopPct: round2(((price - position.stopPrice) / price) * 100),
    rNow: riskPerUnit > 0 ? round2((price - position.entryPrice) / riskPerUnit) : null,
    breakevenArmPrice: profile.breakeven === false || position.partialTaken || !(riskPerUnit > 0) ? null : roundPrice(position.entryPrice + cfg.partialAtR * riskPerUnit),
    targetPrice: targetR && riskPerUnit > 0 ? roundPrice(position.entryPrice + targetR * riskPerUnit) : null,
    timeStopAt: timeStopActive ? position.openedBarTime * 1000 + tfMs * (1 + timeStopBars) : null,
    nextCheckAt: forming ? forming.time * 1000 + tfMs : null,
    nextCheckLabel: forming ? formatTime(forming.time * 1000 + tfMs, cfg.timeZone) : null
  };
}

// Returns { headline, byProfile, exit } for one coin.
export function predictCoin({ symbol, series, live, cfg, portfolio, risk, symbolState, autoTradeOn, usdIdrRate, nowMs = Date.now() }) {
  const held = portfolio.positions?.[symbol];
  if (held) {
    const exit = exitPrediction({ position: held, series, live, cfg, nowMs });
    return { headline: exit, byProfile: {}, exit };
  }
  const byProfile = {};
  for (const profile of Object.values(profilesFor(cfg))) {
    if (!cfg.profiles?.[profile.key]) continue;
    const prediction = profilePrediction({ symbol, profile, series, live, cfg, portfolio, risk, symbolState, autoTradeOn, usdIdrRate, nowMs });
    if (prediction) byProfile[profile.key] = prediction;
  }
  const headline = Object.values(byProfile).sort((a, b) =>
    (STAGE_RANK[b.stage] - STAGE_RANK[a.stage]) || (b.met / b.total - a.met / a.total) || (a.decisionAt - b.decisionAt))[0] || null;
  return { headline, byProfile, exit: null };
}

// One plain-English sentence for lists, notifications and the AI summary.
export function describePrediction(prediction, symbol) {
  if (!prediction) return 'Not enough market data yet.';
  const base = symbol ? symbol.replace('USDT', '') : 'This coin';
  if (prediction.stage === 'holding') {
    const r = prediction.rNow != null ? `${prediction.rNow >= 0 ? '+' : ''}${prediction.rNow}R` : '';
    return `Holding ${base} ${r}. Stop at ${prediction.stopPrice} (${prediction.distanceToStopPct}% away, ${prediction.stopKind}).`;
  }
  const tf = TF_NAME[prediction.timeframe];
  if (prediction.stage === 'blocked') {
    const failing = prediction.conditions.filter((c) => GATE_KEYS.includes(c.key) && !c.ok && !c.na).map((c) => c.failText);
    return `Not in play: ${failing.slice(0, 2).join(' and ') || 'market conditions are not met'}.`;
  }
  if (prediction.stage === 'watching' && prediction.entry === 'breakout') {
    return `Watching: buys on a ${tf} close above ${prediction.trigger.price} (${prediction.trigger.distancePct}% away).`;
  }
  if (prediction.stage === 'watching') {
    const tfTrendOk = prediction.conditions.find((c) => c.key === 'tfTrend')?.ok;
    return tfTrendOk
      ? `Watching: the ${tf} uptrend is intact, waiting for a pullback to the EMA20.`
      : `Watching: the bigger trend is up, waiting for the ${tf} chart to turn up again.`;
  }
  const hold = prediction.canFire ? '' : ` It won't fire yet: ${prediction.blockers[0]}`;
  if (prediction.stage === 'ready') {
    return `Ready: if the ${tf} candle closes like this at ${prediction.decisionLabel}, the robot buys around ${prediction.plan?.entryPrice ?? prediction.trigger.livePrice}.${hold}`;
  }
  return `Setting up: buys if the ${tf} candle closes above ${prediction.trigger.price} (${prediction.trigger.distancePct}% away) at ${prediction.decisionLabel}.${hold}`;
}
