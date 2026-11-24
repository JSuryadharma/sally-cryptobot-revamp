// The IDX stocks half of an engine pass. Runs inside the crypto tick (same
// lease, same transaction), on the same stored portfolio: its own positions
// (account.js bookView) but the shared cash pool. The engine loop, sizing,
// risk brakes, pre-trade check and ledger are the same modules crypto uses;
// only the candles (markets/idx.js) and the config differ.
import { advance, createEngineState } from './core.js';
import { bookView } from '../account.js';
import { loadIdxSeries, idxEngineCfg, idxSessionOpen, IDX_REGIME_SYMBOL, IDX_NAMES } from '../markets/idx.js';
import { aboveSma, regimeAllows, regimeDaysOf, regimeNote } from './paperBreakout.js';
import { buildOrderList } from './orderPlans.js';
import { positionOdds, breakoutPlans, scannerFor } from './insights.js';
import { quoteVolume24h } from './setups.js';
import { profilesFor } from './config.js';
import { dipCheck } from './strategies/dip.js';

export const IDX_STATE_KEY = 'idx-engine-state.json';
export const IDX_CACHE_KEY = 'idx-cache.json';
// Yahoo is polled every 5 minutes around the session, every 30 minutes otherwise.
const ACTIVE_GAP_MS = 5 * 60_000;
const IDLE_GAP_MS = 30 * 60_000;

function due(lastRunMs, nowMs) {
  if (!lastRunMs) return true;
  const active = idxSessionOpen(nowMs) || idxSessionOpen(nowMs - 45 * 60_000);
  return nowMs - lastRunMs >= (active ? ACTIVE_GAP_MS : IDLE_GAP_MS);
}

function round(v, d = 2) { return Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null; }

// Per-stock card for the dashboard.
export function buildIdxView({ symbol, series, live, cfg, positions, plan, scan, regimeOk }) {
  const daily = series[symbol]?.['1d'];
  if (!daily?.length) return null;
  const last = daily.at(-1);
  const now = live[symbol]?.['1d'] || last;
  const formingToday = now.date !== last.date;
  const price = now.close;
  const prevClose = formingToday ? last.close : daily.at(-2)?.close;
  const valueIdr = quoteVolume24h(daily, daily.length - 1, 1);
  const liquid = valueIdr >= cfg.minTradeQuoteVolumeUsdt;
  const position = positions[symbol] || null;
  // Dip buy (strategies/dip.js): checked on today's forming candle, so "ready"
  // means it buys at today's close if the price stays like this.
  const dipProfile = cfg.profiles?.idxDip ? profilesFor(cfg).idxDip : null;
  const dipBars = formingToday ? [...daily, now] : daily;
  const dipRaw = dipProfile ? dipCheck(dipBars, dipBars.length - 1, dipProfile) : null;
  const dip = dipRaw ? { ...dipRaw, rsiMax: dipProfile.rsiMax, smaDays: dipProfile.trendSmaBars } : null;
  const dipReady = Boolean(dip?.ok && liquid);
  const dipLine = dip ? (dip.uptrend
    ? ` Dip buy: 2-day RSI ${dip.rsi}, buys under ${dip.rsiMax}.`
    : ` Dip buy: off while it is under its ${dip.smaDays}-day average ${dip.sma}.`) : '';
  let stage = 'watching';
  if (position) stage = 'holding';
  else if (dipReady) stage = 'ready';
  else if (!regimeOk || !liquid) stage = 'blocked';
  else if (plan && plan.distancePct <= 0) stage = 'ready';
  else if (plan && plan.distancePct <= 3) stage = 'setting-up';
  const why = position ? (position.profile === 'idxDip'
    ? 'Holding a dip buy: the robot sells at the first close above the 5-day average, after 10 days, or at the 10% stop.'
    : 'Holding: the robot sells at the stop, the target or after 30 days.')
    : dipReady ? `Dip buy: 2-day RSI ${dip.rsi} is under ${dip.rsiMax} and the price is above its ${dip.smaDays}-day average ${dip.sma}. Buys at today's close if it stays like this.`
    : (!regimeOk ? `Market filter not met (${regimeNote(cfg, 'IHSG')}), so the robot does not buy it.`
      : !liquid ? `Daily value Rp ${(valueIdr / 1e9).toFixed(1)}B is under the Rp ${(cfg.minTradeQuoteVolumeUsdt / 1e9).toFixed(0)}B floor.`
        : plan?.distancePct <= 0 ? `Trading above its 55-day high ${plan.level}: buys if it closes there today.`
          : plan ? `Needs a daily close above ${plan.level} (${plan.distancePct}% away).` : 'Not enough history yet.') + (liquid ? dipLine : '');
  return {
    symbol, market: 'idx', name: IDX_NAMES[symbol]?.[0] || symbol,
    price, prevClose, changePct: prevClose ? round((price / prevClose - 1) * 100) : null,
    date: now.date, sessionDate: last.date,
    sparkline: daily.slice(-30).map((c) => c.close),
    atr14: last.atr14, atrPct: last.atrPct, rsi14: last.rsi14,
    valueIdr: Math.round(valueIdr), liquid, regimeOk, stage, why, plan: plan || null, dip,
    setups: scan?.labels || [],
    position: position ? { profile: position.profile, quantity: position.quantity, lots: position.quantity / 100, entryPrice: position.entryPrice, stopPrice: position.stopPrice, targetPrice: position.targetPrice, openedAt: position.openedAt } : null
  };
}

// Returns null when IDX trading is off or not due; otherwise the result,
// with `writes` for the caller's single transaction.
export async function idxPass({ settings, portfolio, nowMs, stored, loader = loadIdxSeries, force = false }) {
  const idx = settings.idx;
  if (!idx?.enabled) return null;
  if (!force && !due(stored?.lastRunMs, nowMs)) return null;
  const engineState = stored?.engine?.version === 2 ? stored.engine : createEngineState();
  const view = bookView(portfolio, 'idx');
  const held = Object.keys(view.positions);
  const symbols = [...new Set([...idx.watchlist, ...held, IDX_REGIME_SYMBOL])];
  const { series, live, errors } = await loader(symbols, { nowMs });
  const cfg = idxEngineCfg(settings);
  const tradeSymbols = idx.autoTrade ? idx.watchlist.filter((s) => series[s]) : [];
  const out = advance(engineState, view, series, { nowMs, live: true, usdIdrRate: 1, cfg, tradeSymbols });
  for (const tx of out.transactions) tx.market = 'idx';

  const regime = series[IDX_REGIME_SYMBOL]?.['1d'];
  const smaDays = regimeDaysOf(cfg);
  const regimeOk = Boolean(regime?.length) && aboveSma(regime, regime.at(-1).time, smaDays);
  const stockSeries = Object.fromEntries(Object.entries(series).filter(([s]) => s !== IDX_REGIME_SYMBOL));
  const plans = breakoutPlans({ symbols: Object.keys(stockSeries), series, live, cfg, profileKey: 'idxBreakout' });
  const scan = scannerFor(stockSeries, { minValue: 5_000_000_000, minPrice: 50 });
  const scanBySymbol = Object.fromEntries(scan.map((s) => [s.symbol, s]));
  const stocks = {};
  for (const symbol of new Set([...idx.watchlist, ...held])) {
    const daily = series[symbol]?.['1d'];
    const stockOk = Boolean(daily?.length) && regimeAllows(cfg, regime, daily, daily.at(-1).time);
    const v = buildIdxView({ symbol, series, live, cfg, positions: view.positions, plan: plans[symbol], scan: scanBySymbol[symbol], regimeOk: stockOk });
    if (v) stocks[symbol] = v;
  }
  let ihsg = null;
  if (regime?.length) {
    const last = regime.at(-1);
    let sum = 0;
    for (let k = Math.max(0, regime.length - smaDays); k < regime.length; k += 1) sum += regime[k].close;
    const sma = sum / Math.min(smaDays, regime.length);
    const nowBar = live[IDX_REGIME_SYMBOL]?.['1d'] || last;
    ihsg = { close: nowBar.close, date: nowBar.date, sma: round(sma), smaDays, abovePct: round((last.close / sma - 1) * 100), regimeOk, sparkline: regime.slice(-60).map((c) => c.close) };
  }
  const prices = Object.fromEntries(Object.keys(stockSeries).map((s) => [s, live?.[s]?.['1d']?.close ?? series[s]['1d'].at(-1)?.close]));
  const equityIdr = portfolio.balanceIdr + [...Object.values(portfolio.positions || {}), ...Object.values(view.positions || {})].reduce((t, p) => t + (p.investedIdr || 0), 0);
  const orders = buildOrderList({
    market: 'idx', plans, prices, positions: view.positions, cfg, equityIdr, cashIdr: portfolio.balanceIdr, nowMs,
    allowed: (s) => { const d = series[s]?.['1d']; return Boolean(d?.length) && regimeAllows(cfg, regime, d, d.at(-1).time); }
  });
  const cache = {
    updatedAt: new Date(nowMs).toISOString(),
    orders,
    sessionOpen: idxSessionOpen(nowMs),
    ihsg, stocks, scanner: scan.slice(0, 20),
    odds: positionOdds({ positions: view.positions, series, live, cfg }),
    errors: errors.map((e) => ({ symbol: e.symbol, error: e.error })),
    signals: out.signals.slice(0, 30),
    fills: out.transactions.map((t) => ({ symbol: t.symbol, type: t.type, price: t.price, quantity: t.quantity, realizedProfitIdr: t.realizedProfitIdr ?? null, rMultiple: t.rMultiple ?? null, reason: t.reason, at: t.createdAt }))
  };
  const recent = [...cache.fills.map((f) => ({ ...f, at: new Date(nowMs).toISOString() })), ...(stored?.recentFills || [])].slice(0, 50);
  return {
    out, series, live, cfg, cache,
    writes: {
      [IDX_STATE_KEY]: { lastRunMs: nowMs, engine: engineState, recentFills: recent },
      [IDX_CACHE_KEY]: cache
    }
  };
}
