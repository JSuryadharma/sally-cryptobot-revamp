// Long-only entry setups. Pure: works on enriched candle arrays plus an index,
// so the backtester can scan history without slicing arrays per bar.

function finite(...values) { return values.every((v) => Number.isFinite(v)); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function roundPrice(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(8));
}

function check(checklist, key, label, ok, detail) {
  checklist.push({ key, label, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// Approximates 24h quote volume from the candles themselves, so live and
// backtest apply the same liquidity rule without a historical ticker.
export function quoteVolume24h(trig, i, barsPer24h) {
  let sum = 0;
  for (let k = Math.max(0, i - barsPer24h + 1); k <= i; k += 1) sum += (trig[k].volume || 0) * trig[k].close;
  return sum;
}

export function trendFilter(filt, j, slopeBars) {
  const f = filt[j];
  const past = filt[j - slopeBars];
  if (!f || !past || !finite(f.close, f.ema20, f.ema50, past.ema50)) return { ok: false, detail: 'trend filter warming up' };
  const ok = f.close > f.ema50 && f.ema20 > f.ema50 && f.ema50 > past.ema50;
  return {
    ok,
    detail: `close ${roundPrice(f.close)} ${f.close > f.ema50 ? '>' : '<='} EMA50 ${roundPrice(f.ema50)}, EMA20 ${f.ema20 > f.ema50 ? '>' : '<='} EMA50, EMA50 ${f.ema50 > past.ema50 ? 'rising' : 'flat/falling'}`
  };
}

function placeStop(entry, rawStop, atr, cfg) {
  const p = cfg.setup;
  const minDist = Math.max(p.minStopAtr * atr, entry * p.minStopCostMult * cfg.roundTripCostPct / 100);
  let stop = rawStop;
  if (entry - stop < minDist) stop = entry - minDist;
  if (entry - stop > p.maxStopAtr * atr) return { stop: null, reason: `stop ${((entry - rawStop) / atr).toFixed(1)}x ATR away is wider than ${p.maxStopAtr}x` };
  return { stop: roundPrice(stop) };
}

function scoreSetup({ trig, i, filt, j, entry, stop, pullbackDepthAtr, cfg }) {
  const c = trig[i];
  const f = filt[j];
  const p = cfg.setup;
  const parts = [];

  parts.push([25, finite(f.ema20, f.ema50, f.atr14) && f.atr14 > 0 ? clamp01(((f.ema20 - f.ema50) / f.atr14) / 1.5) : 0]);
  const depth = Number.isFinite(pullbackDepthAtr) ? (pullbackDepthAtr >= -1 ? 1 : clamp01(1 - (-1 - pullbackDepthAtr) / 1.5)) : 0.5;
  parts.push([20, depth]);
  const range = c.high - c.low;
  parts.push([20, range > 0 ? clamp01((c.close - c.low) / range) : 0.5]);
  parts.push([15, finite(c.volume, c.volumeSma20) && c.volumeSma20 > 0 ? clamp01((c.volume / c.volumeSma20 - 0.5) / 1.0) : 0.5]);
  const adx = c.adx14;
  let adxScore = 0.5;
  if (Number.isFinite(adx)) adxScore = adx < 15 ? 0 : adx < 25 ? (adx - 15) / 10 : adx <= 40 ? 1 : Math.max(0.5, 1 - (adx - 40) / 20);
  parts.push([10, adxScore]);
  let highest = -Infinity;
  for (let k = Math.max(0, i - p.roomLookback); k < i; k += 1) highest = Math.max(highest, trig[k].high);
  const riskPerUnit = entry - stop;
  const roomR = Number.isFinite(highest) && riskPerUnit > 0 ? (highest - entry) / riskPerUnit : 2;
  parts.push([10, highest <= entry ? 1 : clamp01(roomR / 2)]);

  const total = parts.reduce((s, [w]) => s + w, 0);
  return Math.round((parts.reduce((s, [w, v]) => s + w * v, 0) / total) * 100);
}

function evaluatePullback(ctx, checklist) {
  const { trig, i, profile, cfg } = ctx;
  const p = cfg.setup;
  const c = trig[i];
  const prev = trig[i - 1];

  const trendOk = check(checklist, 'tfTrend', `${profile.triggerTf} uptrend (EMA20 > EMA50, close > EMA50)`,
    c.ema20 > c.ema50 && c.close > c.ema50,
    `EMA20 ${roundPrice(c.ema20)} / EMA50 ${roundPrice(c.ema50)}, close ${roundPrice(c.close)}`);

  let touched = false;
  let depth = Infinity;
  let minRsi = Infinity;
  let swingLow = c.low;
  for (let k = i - p.pullbackLookback; k < i; k += 1) {
    const b = trig[k];
    if (!b || !finite(b.low, b.ema20, b.atr14, b.rsi14) || b.atr14 <= 0) continue;
    const dist = (b.low - b.ema20) / b.atr14;
    depth = Math.min(depth, dist);
    if (dist <= p.pullbackTouchAtr) touched = true;
    minRsi = Math.min(minRsi, b.rsi14);
    swingLow = Math.min(swingLow, b.low);
  }
  const rsiDipOk = minRsi >= p.rsiDipMin && minRsi <= p.rsiDipMax;
  const pullbackOk = check(checklist, 'pullback', `pullback to EMA20 in the last ${p.pullbackLookback} bars, RSI dipped to ${p.rsiDipMin}-${p.rsiDipMax}`,
    touched && rsiDipOk,
    `${touched ? 'touched EMA20 zone' : 'no touch'}${Number.isFinite(minRsi) ? `, min RSI ${minRsi.toFixed(1)}` : ''}`);

  const armedLevel = trendOk && pullbackOk ? roundPrice(c.high) : null;

  const reclaimOk = check(checklist, 'reclaim', 'trigger bar reclaims (close > prior high, green, RSI rising)',
    c.close > prev.high && c.close > c.open && c.rsi14 > prev.rsi14,
    `close ${roundPrice(c.close)} vs prior high ${roundPrice(prev.high)}`);

  const chaseOk = check(checklist, 'noChase', `not extended (close - EMA20 <= ${p.chaseMaxAtr}x ATR, RSI <= ${p.rsiMax})`,
    (c.close - c.ema20) <= p.chaseMaxAtr * c.atr14 && c.rsi14 <= p.rsiMax,
    `${((c.close - c.ema20) / c.atr14).toFixed(2)}x ATR above EMA20, RSI ${c.rsi14.toFixed(1)}`);

  if (!(trendOk && pullbackOk && reclaimOk && chaseOk)) return { signal: null, armedLevel };

  const entry = c.close;
  const placed = placeStop(entry, swingLow - p.stopBufferAtr * c.atr14, c.atr14, cfg);
  if (!check(checklist, 'stop', 'stop distance within limits', placed.stop != null, placed.reason || `stop ${placed.stop}`)) {
    return { signal: null, armedLevel };
  }
  return {
    signal: {
      setup: 'pullback', entryPrice: entry, stopPrice: placed.stop,
      score: scoreSetup({ ...ctx, entry, stop: placed.stop, pullbackDepthAtr: depth }),
      reason: `Pullback to EMA20 reclaimed on ${profile.triggerTf} (min RSI ${minRsi.toFixed(1)}), ${profile.filterTf} trend up.`
    },
    armedLevel
  };
}

function evaluateBreakout(ctx, checklist) {
  const { trig, i, profile, cfg } = ctx;
  const p = cfg.setup;
  const c = trig[i];
  const prev = trig[i - 1];
  let highest = -Infinity;
  for (let k = i - p.breakoutLookback; k < i; k += 1) if (trig[k]) highest = Math.max(highest, trig[k].high);

  const ok = c.close > highest
    && finite(c.volume, c.volumeSma20) && c.volume >= p.breakoutVolMult * c.volumeSma20
    && Number.isFinite(c.adx14) && c.adx14 >= 20 && c.adx14 > prev.adx14
    && c.close > c.ema50 && c.ema20 > c.ema50
    && (c.close - c.ema20) <= p.breakoutChaseAtr * c.atr14
    && c.rsi14 <= 75;
  check(checklist, 'breakout', `${p.breakoutLookback}-bar high breakout on ${p.breakoutVolMult}x volume, ADX rising`, ok,
    `close ${roundPrice(c.close)} vs ${p.breakoutLookback}-bar high ${roundPrice(highest)}`);
  if (!ok) return { signal: null };

  const entry = c.close;
  const placed = placeStop(entry, Math.max(c.low - p.stopBufferAtr * c.atr14, entry - p.breakoutStopAtr * c.atr14), c.atr14, cfg);
  if (placed.stop == null) return { signal: null };
  return {
    signal: {
      setup: 'breakout', entryPrice: entry, stopPrice: placed.stop,
      score: scoreSetup({ ...ctx, entry, stop: placed.stop, pullbackDepthAtr: null }),
      reason: `Breakout above the ${p.breakoutLookback}-bar high on ${profile.triggerTf} with volume, ${profile.filterTf} trend up.`
    }
  };
}

// ctx: { trig, i, filt, j, profile, cfg, btc?: { filt, j } }
// Returns { signal|null, checklist, armedLevel }.
export function evaluateSetup(ctx) {
  const { trig, i, filt, j, profile, cfg } = ctx;
  const p = cfg.setup;
  const checklist = [];
  const c = trig[i];
  const prev = trig[i - 1];
  const warm = c && prev && finite(c.close, c.open, c.high, c.low, c.ema20, c.ema50, c.atr14, c.rsi14, prev.high, prev.rsi14) && c.atr14 > 0
    && i >= Math.max(p.pullbackLookback, p.breakoutLookback) + 1;
  if (!warm || j == null || j < p.trendSlopeBars) {
    check(checklist, 'data', 'indicators ready', false, 'not enough closed candles yet');
    return { signal: null, checklist, armedLevel: null };
  }

  const trend = trendFilter(filt, j, p.trendSlopeBars);
  const trendOk = check(checklist, 'htfTrend', `${profile.filterTf} trend up (close > EMA50, EMA20 > EMA50, EMA50 rising)`, trend.ok, trend.detail);

  let btcOk = true;
  if (cfg.btcGate && ctx.btc) {
    const bf = ctx.btc.filt?.[ctx.btc.j];
    btcOk = check(checklist, 'btcGate', `BTC above EMA50 on ${profile.filterTf}`, bf && bf.close > bf.ema50, bf ? `BTC ${roundPrice(bf.close)} vs EMA50 ${roundPrice(bf.ema50)}` : 'no BTC data');
  }

  const atrPct = (c.atr14 / c.close) * 100;
  const volUsdt = quoteVolume24h(trig, i, profile.barsPer24h);
  const tradeable = check(checklist, 'tradeable', `liquid and moving (24h vol >= $${Math.round(cfg.minTradeQuoteVolumeUsdt / 1e6)}M, ATR >= ${p.minAtrPct}%)`,
    atrPct >= p.minAtrPct && volUsdt >= cfg.minTradeQuoteVolumeUsdt,
    `24h vol ~$${(volUsdt / 1e6).toFixed(1)}M, ATR ${atrPct.toFixed(2)}%`);

  const pullback = evaluatePullback(ctx, checklist);
  const gatesOk = trendOk && btcOk && tradeable;
  let signal = gatesOk ? pullback.signal : null;
  if (!signal && gatesOk && cfg.enableBreakout) signal = evaluateBreakout(ctx, checklist).signal;

  return {
    signal,
    checklist,
    armedLevel: gatesOk ? pullback.armedLevel : null,
    directionBlocked: !trendOk || !btcOk
  };
}
