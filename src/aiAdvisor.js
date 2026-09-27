// Market summary for the coin page. Local mode (the default, no API key)
// scores the daily candle's indicators deterministically; optional OpenAI mode
// narrates the same numbers and never replaces them.

const ADX_TREND_FLOOR = 20;

// -5..+5 rule-based score from the daily candle.
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

export function scoreToGaugePct(score) {
  const clamped = Math.max(-5, Math.min(5, score));
  return Math.round(((clamped + 5) / 10) * 100);
}

function localSummary({ symbol, snapshot, headline }) {
  const { score, points } = scoreSnapshot(snapshot);
  const label = scoreToLabel(score);
  const bullets = points.filter((p) => p.direction !== 'neutral').slice(0, 3).map((p) => p.label);
  return [
    `${symbol}: ${label} on the daily chart (score ${score >= 0 ? '+' : ''}${score}/5).`,
    bullets.length ? `Driven by: ${bullets.join(', ')}.` : 'Signals are mixed right now.',
    headline || ''
  ].join(' ').trim();
}

export async function getMarketSummary({ symbol, snapshot, headline, entryOrExit, aiSettings }) {
  const local = localSummary({ symbol, snapshot, headline });
  const { score, points } = scoreSnapshot(snapshot);
  const base = { mode: 'local', score, label: scoreToLabel(score), gaugePct: scoreToGaugePct(score), points, text: local, createdAt: new Date().toISOString() };

  const ai = aiSettings || {};
  if (ai.mode !== 'openai' || !ai.openaiApiKey) return base;

  try {
    const prompt = [
      'You are a terse crypto technical-analysis assistant inside a PAPER-TRADING dashboard (no real money moves). ',
      `Symbol: ${symbol}. Robot status: ${headline}. Robot action: ${entryOrExit?.action}.`,
      `Daily indicators: ${JSON.stringify(points)}.`,
      'In 2 short sentences, summarize the setup and note the key risk. Do not give financial advice or price predictions.'
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
