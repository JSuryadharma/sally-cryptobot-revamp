// Daily breakout strategy (profiles `breakout`, `breakout55`, and the IDX
// breakout): buy above the prior N-day high while the market's regime symbol
// (BTC for crypto, IHSG for IDX stocks) closes above its 200-day average (cfg.regimeMode can also accept the coin or stock itself).
//
// When it buys is set by cfg.breakoutEntry:
// - 'close' (default): the daily close above the level, as researched.
// - 'nextClose': a daily close above the level, confirmed by the next daily
//   close still above that same level; bought at the confirming close.
// - 'touch': the first closed earlyTf (5m) candle above the level, mid-day.
//   Optional price-action filters, comma-separated after 'touch:':
//   b<x> the 5m close must clear the level by x daily ATRs; v<x> the breaking
//   5m candle's volume must be x times its 24h average; k<m> buy at the close
//   of an m-minute candle that closed above the level (e.g. k15, k60).
// - 'hold:<hours>': live price has closed every earlyTf candle above the level
//   for the last <hours>, bought at that moment.
// - 'cont': yesterday closed as a breakout and live price trades above
//   yesterday's high (follow-through), bought at that moment.
import { scanSetups } from '../../tools/scanner.js';
import { TF_MS, regimeSymbolOf, regimeLabelOf } from '../config.js';
import { evaluateSetup, quoteVolume24h } from '../setups.js';
import { regimeAllows, regimeNote } from '../paperBreakout.js';
import { lastClosedIndex, priorHighOf, roundPx } from '../bars.js';

export function breakoutMode(cfg) {
  const raw = String(cfg?.breakoutEntry || 'close');
  if (raw.startsWith('hold:')) return { kind: 'hold', holdMs: Number(raw.slice(5)) * 3_600_000 };
  if (raw === 'touch' || raw.startsWith('touch:')) {
    const mode = { kind: 'touch', holdMs: 0 };
    for (const part of raw.slice(6).split(/[,+]/).filter(Boolean)) {
      const value = Number(part.slice(1));
      if (!Number.isFinite(value)) continue;
      if (part[0] === 'b') mode.bufferAtr = value;
      else if (part[0] === 'v') mode.volMult = value;
      else if (part[0] === 'k') mode.candleMin = value;
    }
    return mode;
  }
  return { kind: ['nextClose', 'cont'].includes(raw) ? raw : 'close', holdMs: 0 };
}

// True when the breakout is bought on live (earlyTf) candles instead of a daily close.
function liveBreakout(profile, cfg) {
  if (!TF_MS[cfg.earlyTf]) return false;
  const { kind } = breakoutMode(cfg);
  return kind === 'touch' || kind === 'hold' || kind === 'cont';
}

function regimeCtx(series, profile, cfg, closeMs) {
  const regime = series[regimeSymbolOf(cfg)]?.[profile.filterTf];
  return regime ? { filt: regime, j: lastClosedIndex(regime, profile.filterTf, closeMs) } : null;
}

// Live breakout check at a closed earlyTf candle against the closed daily candles.
function evaluateIntrabar(ctx, event, profile) {
  const { series, cfg } = ctx;
  const daily = series[event.symbol][profile.triggerTf];
  const sub = series[event.symbol][cfg.earlyTf];
  if (!daily || !sub) return null;
  const n = profile.breakoutLookback;
  const ci = lastClosedIndex(daily, profile.triggerTf, event.closeMs);
  if (ci < n + 1) return null;
  const d = daily[ci];
  if (!(d.atr14 > 0)) return null;
  const level = priorHighOf(daily, ci, n);
  const price = sub[event.i].close;
  if (!(price > level)) return null;
  const mode = breakoutMode(cfg);
  if (mode.kind === 'hold') {
    const bars = Math.max(1, Math.round(mode.holdMs / TF_MS[cfg.earlyTf]));
    if (event.i - bars + 1 < 0) return null;
    for (let q = event.i - bars + 1; q < event.i; q += 1) if (!(sub[q].close > level)) return null;
  } else if (mode.kind === 'cont') {
    if (!(d.close > priorHighOf(daily, ci - 1, n))) return null;
  } else if (mode.kind === 'touch') {
    if (mode.bufferAtr && !(price > level + mode.bufferAtr * d.atr14)) return null;
    if (mode.candleMin && event.closeMs % (mode.candleMin * 60_000) !== 0) return null;
    if (mode.volMult) {
      const bars = Math.round(TF_MS['1d'] / TF_MS[cfg.earlyTf]);
      if (event.i < bars) return null;
      let sum = 0;
      for (let q = event.i - bars; q < event.i; q += 1) sum += sub[q].volume || 0;
      if (!((sub[event.i].volume || 0) >= mode.volMult * (sum / bars))) return null;
    }
  }
  if (!regimeAllows(cfg, series[regimeSymbolOf(cfg)]?.[profile.filterTf], daily, d.time)) return null;
  if (quoteVolume24h(daily, ci, profile.barsPer24h) < cfg.minTradeQuoteVolumeUsdt) return null;
  const stop = roundPx(price - profile.stopAtr * d.atr14);
  if (!(stop > 0)) return null;
  const formingTime = d.time + TF_MS[profile.triggerTf] / 1000;
  const what = mode.kind === 'hold' ? `held above the prior ${n}-day high ${roundPx(level)} for ${mode.holdMs / 3_600_000}h`
    : mode.kind === 'cont' ? `traded above yesterday's breakout high ${roundPx(d.high)}`
      : `broke the prior ${n}-day high ${roundPx(level)}`;
  return {
    signal: {
      setup: 'breakout', entryPrice: price, stopPrice: stop,
      score: Math.round(Math.max(0, Math.min(1, (price - level) / d.atr14)) * 100),
      reason: `Live price ${roundPx(price)} ${what}, ${regimeNote(cfg, regimeLabelOf(cfg))}.`
    },
    checklist: [],
    armedLevel: roundPx(level),
    barTime: formingTime
  };
}

// Check at the daily close.
// Optional day-trader-skill confirmation (profile.minSkillSetups): keep a
// close breakout only when the skill's daily scanner (tools/scanner.js) finds
// at least that many setups on the same bar.
function skillConfirmed(evaluation, trig, i, profile) {
  if (!profile.minSkillSetups || !evaluation?.signal) return evaluation;
  const hits = scanSetups(trig.slice(Math.max(0, i - 40), i + 1))?.setups || [];
  if (hits.length >= profile.minSkillSetups) return { ...evaluation, signal: { ...evaluation.signal, reason: `${evaluation.signal.reason} Skill setups: ${hits.join(', ')}.` } };
  return { ...evaluation, signal: null, skillSetups: hits };
}

function evaluateClose(ctx, event, profile) {
  const { series, cfg } = ctx;
  const trig = series[event.symbol][profile.triggerTf];
  const filt = series[event.symbol][profile.filterTf];
  if (!filt) return null;
  const j = lastClosedIndex(filt, profile.filterTf, event.closeMs);
  const btc = regimeCtx(series, profile, cfg, event.closeMs);
  const evaluation = evaluateSetup({ trig, i: event.i, filt, j: j < 0 ? null : j, profile, cfg, btc });
  const mode = breakoutMode(cfg);
  if (liveBreakout(profile, cfg)) return { ...evaluation, signal: null };
  if (mode.kind !== 'nextClose') return skillConfirmed(evaluation, trig, event.i, profile);
  // Confirmation: yesterday's close broke out and today's close is still above that level.
  const prev = event.i > 0 ? evaluateSetup({ trig, i: event.i - 1, filt, j: j < 1 ? null : j - 1, profile, cfg, btc: btc && { ...btc, j: btc.j - 1 } }) : null;
  const c = trig[event.i];
  let signal = null;
  if (prev?.signal && prev.armedLevel != null && c.close > prev.armedLevel && c.atr14 > 0) {
    const stop = roundPx(c.close - profile.stopAtr * c.atr14);
    if (stop > 0) {
      signal = {
        ...prev.signal, entryPrice: c.close, stopPrice: stop,
        reason: `Daily close ${roundPx(c.close)} still above the ${profile.breakoutLookback}-day high ${prev.armedLevel} it broke yesterday, ${regimeNote(cfg, regimeLabelOf(cfg))}.`
      };
    }
  }
  return { ...evaluation, signal };
}

export const breakoutStrategy = {
  key: 'breakout',
  usesIntrabar: liveBreakout,
  evaluateIntrabar,
  evaluateClose
};
