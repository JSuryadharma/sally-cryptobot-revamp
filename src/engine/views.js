// Builds the per-coin payload the dashboard reads from coins-cache.json.
import { predictCoin, describePrediction } from './prediction.js';
import { describeProfile } from './config.js';
import { getMarketSummary } from '../aiAdvisor.js';

export async function buildCoinView({ symbol, series, live, cfg, portfolio, engineState, settings, usdIdrRate, nowMs, fills = [] }) {
  const prediction = predictCoin({
    symbol, series, live, cfg, portfolio, risk: engineState.risk, symbolState: engineState.symbols?.[symbol],
    autoTradeOn: settings.autoTrade.enabled, usdIdrRate, nowMs
  });
  const head = prediction.headline;
  const sentence = describePrediction(head, symbol);
  const lastFill = fills.filter((t) => t.symbol === symbol).at(-1) || null;
  const daily = live[symbol]?.['1d'] || series[symbol]?.['1d']?.at(-1) || null;

  const entryOrExit = {
    action: lastFill ? lastFill.type : 'HOLD',
    executed: Boolean(lastFill),
    reason: lastFill ? lastFill.reason : sentence,
    confidencePct: head?.score ?? (head?.total ? Math.round((head.met / head.total) * 100) : null),
    armedLevel: head && (head.stage === 'setting-up' || head.stage === 'ready') ? head.trigger.price : null,
    triggerKind: 'pullback',
    directionBlocked: head?.stage === 'blocked'
  };
  const summary = await getMarketSummary({ symbol, snapshot: { latest: daily }, headline: sentence, entryOrExit, aiSettings: settings.ai });

  return {
    symbol,
    activeMode: head?.profile ?? null,
    latest: daily,
    sparkline: (series[symbol]?.['1h'] || []).slice(-24).map((c) => c.close),
    summary,
    entryOrExit,
    prediction: { ...prediction, sentence },
    strategyParams: head?.profile ? describeProfile(head.profile, cfg) : null,
    transaction: lastFill,
    updatedAt: new Date(nowMs).toISOString()
  };
}
