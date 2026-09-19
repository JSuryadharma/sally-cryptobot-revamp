// The Dribbble reference screenshot's "Technical Analysis / Overall Summary"
// gauge (Bearish - Neutral - Bullish) plus a recommended trading mode. Local
// mode (the default - no API key needed) computes this deterministically from
// the same indicators already on the snapshot, so the dashboard works fully
// out of the box. Optional OpenAI mode layers a natural-language paragraph on
// top of the same computed score - it never replaces the underlying numbers,
// only narrates them, same convention as robotrader's aiAdvisor.js.

import { ADX_TREND_FLOOR } from './decisionEngine.js';

// -5..+5 rule-based score from the daily (swing-timeframe) snapshot, used as
// the "big picture" gauge regardless of which mode is actually recommended.
export function scoreSnapshot(snapshot) {
  const c = snapshot?.latest;
  if (!c) return { score: 0, points: [] };
  const points = [];
  let score = 0;

  if (Number.isFinite(c.ema20) && Number.isFinite(c.ema50)) {
    const bullish = c.ema20 > c.ema50;
    score += bullish ? 1 : -1;
    points.push({ label: 'EMA20 vs EMA50', direction: bullish ? 'bullish' : 'bearish' });
  }
  if (Number.isFinite(c.close) && Number.isFinite(c.ema20)) {
    const bullish = c.close > c.ema20;
    score += bullish ? 1 : -1;
    points.push({ label: 'Price vs EMA20', direction: bullish ? 'bullish' : 'bearish' });
  }
  if (Number.isFinite(c.rsi14)) {
    if (c.rsi14 >= 55) { score += 1; points.push({ label: `RSI14 ${c.rsi14.toFixed(0)}`, direction: 'bullish' }); }
    else if (c.rsi14 <= 45) { score -= 1; points.push({ label: `RSI14 ${c.rsi14.toFixed(0)}`, direction: 'bearish' }); }
    else points.push({ label: `RSI14 ${c.rsi14.toFixed(0)}`, direction: 'neutral' });
  }
  if (Number.isFinite(c.macdHistogram)) {
    const bullish = c.macdHistogram > 0;
    score += bullish ? 1 : -1;
    points.push({ label: 'MACD histogram', direction: bullish ? 'bullish' : 'bearish' });
  }
  if (Number.isFinite(c.adx14) && Number.isFinite(c.plusDI14) && Number.isFinite(c.minusDI14)) {
    if (c.adx14 >= ADX_TREND_FLOOR && c.plusDI14 > c.minusDI14) { score += 1; points.push({ label: `ADX ${c.adx14.toFixed(0)} +DI led`, direction: 'bullish' }); }
    else if (c.adx14 >= ADX_TREND_FLOOR && c.minusDI14 > c.plusDI14) { score -= 1; points.push({ label: `ADX ${c.adx14.toFixed(0)} -DI led`, direction: 'bearish' }); }
    else points.push({ label: `ADX ${c.adx14.toFixed(0)} (range-bound)`, direction: 'neutral' });
  }

  return { score, points };
}

export function scoreToLabel(score) {
  if (score >= 2) return 'Bullish';
  if (score <= -2) return 'Bearish';
  return 'Neutral';
}

// Percent position along a Bearish(0) -> Bullish(100) gauge, matching the
// three-segment bar in the reference screenshot.
export function scoreToGaugePct(score) {
  const clamped = Math.max(-5, Math.min(5, score));
  return Math.round(((clamped + 5) / 10) * 100);
}

// ADX (trend strength) + ATR% (volatility) decide which of the three
// backtested systems fits current conditions best for this coin. This is a
// heuristic, not itself separately backtested - see README.
export function recommendMode({ swing, scalping }) {
  const adx = swing.latest?.adx14;
  const swingAtrPct = swing.latest?.atrPct;
  const scalpAtrPct = scalping.latest?.atrPct;

  if (Number.isFinite(adx) && adx >= 25 && Number.isFinite(swingAtrPct) && swingAtrPct < 6) {
    return {
      mode: 'swing',
      reason: `Daily ADX ${adx.toFixed(1)} shows a genuine trend with contained volatility (daily ATR ${swingAtrPct.toFixed(1)}%) - worth holding through the noise rather than reacting to every 15-minute wiggle.`
    };
  }
  if (Number.isFinite(adx) && adx < 20) {
    return {
      mode: 'scalping',
      reason: `Daily ADX ${adx.toFixed(1)} is range-bound / choppy - not enough sustained trend to swing, but 15m volatility (ATR ${Number.isFinite(scalpAtrPct) ? scalpAtrPct.toFixed(1) : 'n/a'}%) is tradeable for short in-and-out entries.`
    };
  }
  // Landing here means neither the swing gate (ADX >= 25 AND daily ATR% < 6)
  // nor the scalping gate (ADX < 20) matched. That covers two genuinely
  // different situations that used to share one misleading reason string -
  // a real ADX >= 25 trend that's simply too volatile for swing's ATR cap
  // (previously described as "moderate, still-forming" even at, say, ADX 70+),
  // versus an actually-moderate ADX in the 20-24 gap. Word each accurately.
  const tooVolatileForSwing = Number.isFinite(adx) && adx >= 25;
  return {
    mode: 'dayTrade',
    reason: tooVolatileForSwing
      ? `Daily ADX ${adx.toFixed(1)} shows a real trend, but daily volatility (ATR ${Number.isFinite(swingAtrPct) ? swingAtrPct.toFixed(1) + '%' : 'n/a'}) is too wide for the swing bucket's cap - an hourly day-trade approach captures the intraday move without that overnight swing risk.`
      : `Daily ADX ${Number.isFinite(adx) ? adx.toFixed(1) : 'n/a'} is a moderate, still-forming trend - an hourly day-trade approach captures the intraday move without swing-timeframe overnight risk.`
  };
}

function localSummary({ symbol, snapshot, recommendation, entryOrExit }) {
  const { score, points } = scoreSnapshot(snapshot);
  const label = scoreToLabel(score);
  const bullets = points.filter((p) => p.direction !== 'neutral').slice(0, 3).map((p) => p.label);
  const action = entryOrExit?.action || 'HOLD';
  const confidence = Number.isFinite(entryOrExit?.confidencePct) ? `${entryOrExit.confidencePct}% confidence` : null;
  return [
    `${symbol}: ${label} overall (score ${score >= 0 ? '+' : ''}${score}/5).`,
    bullets.length ? `Driven by: ${bullets.join(', ')}.` : 'Signals are mixed right now.',
    `Recommended mode: ${recommendation.mode} - ${recommendation.reason}`,
    `Current robot action: ${action}${confidence ? ` (${confidence})` : ''}. ${entryOrExit?.reason || ''}`
  ].join(' ');
}

export async function getMarketSummary({ symbol, snapshot, recommendation, entryOrExit, aiSettings }) {
  const local = localSummary({ symbol, snapshot, recommendation, entryOrExit });
  const { score, points } = scoreSnapshot(snapshot);
  const base = { mode: 'local', score, label: scoreToLabel(score), gaugePct: scoreToGaugePct(score), points, text: local, createdAt: new Date().toISOString() };

  const ai = aiSettings || {};
  if (ai.mode !== 'openai' || !ai.openaiApiKey) return base;

  try {
    const prompt = [
      `You are a terse crypto technical-analysis assistant inside a PAPER-TRADING dashboard (no real money moves). `,
      `Symbol: ${symbol}. Recommended trading mode: ${recommendation.mode}. Robot action: ${entryOrExit?.action}.`,
      `Indicators: ${JSON.stringify(points)}.`,
      `In 2 short sentences, summarize the setup and note the key risk. Do not give financial advice or price predictions.`
    ].join('\n');
    const response = await fetch(ai.openaiBaseUrl || 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.openaiApiKey}` },
      body: JSON.stringify({ model: ai.model, input: prompt })
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const body = await response.json();
    const text = body.output_text
      || body.output?.flatMap((item) => item.content || []).map((item) => item.text).filter(Boolean).join('\n');
    return { ...base, mode: 'openai', text: text || local };
  } catch (error) {
    return { ...base, mode: 'local-fallback', text: `${local} (OpenAI advisor unavailable: ${error.message})` };
  }
}
