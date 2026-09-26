// The v2 engine loop. Pure (no I/O): the live tick and the backtester both call
// advance(), so a backtest exercises exactly the code that trades live.
//
// advance() walks every closed trigger-timeframe bar not yet processed, across
// all symbols, in time order. For each bar time it first manages open
// positions (stops, partials, trails, exits), then updates the risk brakes,
// then evaluates entries and opens the best-scoring ones that fit.
import { profilesFor, TF_MS, BTC_SYMBOL } from './config.js';
import { evaluateSetup } from './setups.js';
import { onBar } from './positionManager.js';
import { sizePosition, bookEquityIdr } from './sizing.js';
import { openPositionQty, sellPosition, normalizePosition } from './ledger.js';
import { createRiskState, updateRisk, recordTradeResult, entryBlock } from './riskGuard.js';

export function createEngineState() {
  return { version: 2, symbols: {}, risk: createRiskState() };
}

function closeMsOf(bar, tf) {
  return bar.time * 1000 + TF_MS[tf];
}

// Index of the last bar in `bars` closed at or before `ms`, or -1.
function lastClosedIndex(bars, tf, ms) {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMsOf(bars[mid], tf) <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function symbolState(state, symbol) {
  if (!state.symbols[symbol]) state.symbols[symbol] = { lastBarTime: {}, cooldownUntilMs: {} };
  const s = state.symbols[symbol];
  s.lastBarTime ||= {};
  s.cooldownUntilMs ||= {};
  return s;
}

function enabledProfiles(cfg) {
  return Object.values(profilesFor(cfg)).filter((p) => cfg.profiles?.[p.key]);
}

function buildEvents(state, portfolio, series, { nowMs, startMs, live, cfg, tradeSymbols }) {
  const tfsBySymbol = new Map();
  const add = (symbol, tf) => {
    if (!series[symbol]?.[tf]) return;
    if (!tfsBySymbol.has(symbol)) tfsBySymbol.set(symbol, new Set());
    tfsBySymbol.get(symbol).add(tf);
  };
  for (const symbol of tradeSymbols) for (const p of enabledProfiles(cfg)) add(symbol, p.triggerTf);
  for (const position of Object.values(portfolio.positions)) {
    const profile = profilesFor(cfg)[normalizePosition(position).profile];
    if (profile) add(position.symbol, profile.triggerTf);
  }

  const events = [];
  for (const [symbol, tfs] of tfsBySymbol) {
    const sState = symbolState(state, symbol);
    const holding = portfolio.positions[symbol] ? normalizePosition(portfolio.positions[symbol]) : null;
    for (const tf of tfs) {
      const bars = series[symbol][tf];
      if (!bars.length) continue;
      const lastSeen = sState.lastBarTime[tf];
      let start;
      if (lastSeen == null) {
        start = live ? bars.length - 1 : bars.findIndex((b) => closeMsOf(b, tf) > startMs);
        if (start < 0) continue;
      } else {
        start = bars.findIndex((b) => b.time > lastSeen);
        if (start < 0) continue;
      }
      const managesHere = holding && profilesFor(cfg)[holding.profile]?.triggerTf === tf;
      if (live && !managesHere && bars.length - start > cfg.maxCatchUpBars) start = bars.length - 1;
      for (let i = start; i < bars.length; i += 1) {
        const closeMs = closeMsOf(bars[i], tf);
        if (closeMs > nowMs) break;
        events.push({ closeMs, symbol, tf, i });
      }
    }
  }
  events.sort((a, b) => a.closeMs - b.closeMs || a.symbol.localeCompare(b.symbol) || a.tf.localeCompare(b.tf));
  return events;
}

function applyFills(ctx, symbol, fills, bar) {
  const { portfolio, state, cfg, usdIdrRate, out, timeFor, keepAll } = ctx;
  for (const fill of fills) {
    const position = portfolio.positions[symbol];
    if (!position) break;
    const quantity = fill.fraction >= 1 ? undefined : position.quantity * fill.fraction;
    const { transaction, closed, tradeRealizedIdr } = sellPosition(portfolio, {
      symbol, quantity, price: fill.price, reason: fill.reason, exitKind: fill.exitKind,
      timeMs: timeFor(bar), barTime: bar.time, usdIdrRate, roundTripCostPct: cfg.roundTripCostPct, keepAllTransactions: keepAll
    });
    if (!transaction) continue;
    out.transactions.push(transaction);
    if (closed) {
      const riskEvent = recordTradeResult(state.risk, tradeRealizedIdr, ctx.currentMs, cfg);
      if (riskEvent) out.riskEvents.push(riskEvent);
      if (fill.exitKind === 'stop' && tradeRealizedIdr <= 0) {
        const profile = profilesFor(cfg)[transaction.profile];
        if (profile) symbolState(state, symbol).cooldownUntilMs[profile.key] = ctx.currentMs + profile.cooldownBars * TF_MS[profile.triggerTf];
      }
      break;
    }
  }
}

function manage(ctx, event) {
  const { portfolio, series, cfg } = ctx;
  const raw = portfolio.positions[event.symbol];
  if (!raw) return;
  const position = normalizePosition(raw);
  const profile = profilesFor(cfg)[position.profile];
  if (!profile || profile.triggerTf !== event.tf) return;
  portfolio.positions[event.symbol] = position;
  const bar = series[event.symbol][event.tf][event.i];
  const { fills, updates } = onBar(position, bar, profile, cfg);
  if (updates) Object.assign(position, updates);
  if (fills.length) applyFills(ctx, event.symbol, fills, bar);
}

function evaluate(ctx, event, profile) {
  const { series, cfg } = ctx;
  const trig = series[event.symbol][profile.triggerTf];
  const filt = series[event.symbol][profile.filterTf];
  if (!filt) return null;
  const j = lastClosedIndex(filt, profile.filterTf, event.closeMs);
  let btc = null;
  if (cfg.btcGate && series[BTC_SYMBOL]?.[profile.filterTf]) {
    const btcFilt = series[BTC_SYMBOL][profile.filterTf];
    btc = { filt: btcFilt, j: lastClosedIndex(btcFilt, profile.filterTf, event.closeMs) };
  }
  return evaluateSetup({ trig, i: event.i, filt, j: j < 0 ? null : j, profile, cfg, btc });
}

// opts: { nowMs, startMs, live, usdIdrRate, cfg, tradeSymbols, onGroup, keepAllTransactions }
export function advance(state, portfolio, series, opts) {
  const { nowMs, live = false, usdIdrRate, cfg, onGroup } = opts;
  const tradeSymbols = new Set(opts.tradeSymbols);
  state.risk ||= createRiskState();
  const out = { transactions: [], signals: [], riskEvents: [], latestEvaluations: {}, barsProcessed: 0 };
  const ctx = {
    portfolio, state, series, cfg, usdIdrRate, out, currentMs: 0,
    keepAll: Boolean(opts.keepAllTransactions),
    timeFor: (bar) => (live ? nowMs : ctx.currentMs)
  };

  const events = buildEvents(state, portfolio, series, { ...opts, tradeSymbols: [...tradeSymbols] });
  let g = 0;
  while (g < events.length) {
    const closeMs = events[g].closeMs;
    let end = g;
    while (end < events.length && events[end].closeMs === closeMs) end += 1;
    const group = events.slice(g, end);
    ctx.currentMs = closeMs;

    for (const event of group) manage(ctx, event);

    const riskEvent = updateRisk(state.risk, bookEquityIdr(portfolio), closeMs, cfg);
    if (riskEvent) out.riskEvents.push(riskEvent);
    const blocked = entryBlock(state.risk, closeMs, cfg);

    const candidates = [];
    for (const event of group) {
      if (!tradeSymbols.has(event.symbol) || portfolio.positions[event.symbol]) continue;
      const isLatest = event.i === series[event.symbol][event.tf].length - 1;
      for (const profile of enabledProfiles(cfg)) {
        if (profile.triggerTf !== event.tf) continue;
        const evaluation = evaluate(ctx, event, profile);
        if (!evaluation) continue;
        if (live && isLatest) {
          (out.latestEvaluations[event.symbol] ||= {})[profile.key] = { ...evaluation, closeMs, barTime: series[event.symbol][event.tf][event.i].time };
        }
        const signal = evaluation.signal;
        if (!signal) continue;
        const base = { symbol: event.symbol, profile: profile.key, setup: signal.setup, score: signal.score, barTime: series[event.symbol][event.tf][event.i].time };
        const cooldownUntil = symbolState(state, event.symbol).cooldownUntilMs[profile.key];
        let skip = null;
        if (live && !isLatest) skip = 'missed-stale';
        else if (signal.score < cfg.minConfidencePct) skip = `score ${signal.score} below ${cfg.minConfidencePct}`;
        else if (blocked) skip = `entries paused: ${blocked}`;
        else if (cooldownUntil && closeMs < cooldownUntil) skip = 'cooldown after stop-out';
        if (skip) { out.signals.push({ ...base, taken: false, skip }); continue; }
        candidates.push({ ...base, signal, event, profile });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      let skip = null;
      if (portfolio.positions[c.symbol]) skip = 'already holding';
      else if (Object.keys(portfolio.positions).length >= cfg.maxOpenPositions) skip = `max ${cfg.maxOpenPositions} open positions`;
      const entryPrice = c.signal.entryPrice * (1 + cfg.slippagePct / 100);
      let sized = null;
      if (!skip) {
        sized = sizePosition({ portfolio, entryPrice, stopPrice: c.signal.stopPrice, usdIdrRate, cfg });
        if (!(sized.qty > 0)) skip = sized.reason;
      }
      if (skip) { out.signals.push({ symbol: c.symbol, profile: c.profile, setup: c.setup, score: c.score, barTime: c.barTime, taken: false, skip }); continue; }
      const bar = series[c.symbol][c.event.tf][c.event.i];
      const { transaction, note } = openPositionQty(portfolio, {
        symbol: c.symbol, profile: c.profile.key, setup: c.setup, quantity: sized.qty, entryPrice,
        stopPrice: c.signal.stopPrice, riskIdr: sized.riskIdr, score: c.score, reason: c.signal.reason,
        timeMs: ctx.timeFor(bar), barTime: bar.time, usdIdrRate, roundTripCostPct: cfg.roundTripCostPct,
        keepAllTransactions: ctx.keepAll
      });
      out.signals.push({ symbol: c.symbol, profile: c.profile.key, setup: c.setup, score: c.score, barTime: c.barTime, taken: Boolean(transaction), skip: transaction ? null : note });
      if (transaction) out.transactions.push(transaction);
    }

    for (const event of group) {
      symbolState(state, event.symbol).lastBarTime[event.tf] = series[event.symbol][event.tf][event.i].time;
    }
    out.barsProcessed += group.length;
    onGroup?.(closeMs, portfolio);
    g = end;
  }
  return out;
}
