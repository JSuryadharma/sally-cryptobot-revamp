// The v2 engine loop. Pure (no I/O): the live tick and the backtester both call
// advance(), so a backtest exercises exactly the code that trades live.
//
// advance() walks every closed trigger-timeframe bar not yet processed, across
// all symbols, in time order. For each bar time it first manages open
// positions (stops, partials, trails, exits), then updates the risk brakes,
// then evaluates entries and opens the best-scoring ones that fit.
import { profilesFor, exitTfFor, TF_MS, BTC_SYMBOL } from './config.js';
import { evaluateSetup } from './setups.js';
import { onBar, onExitBar } from './positionManager.js';
import { sizePosition, bookEquityIdr } from './sizing.js';
import { openPositionQty, sellPosition, normalizePosition } from './ledger.js';
import { createRiskState, updateRisk, recordTradeResult, entryBlock } from './riskGuard.js';
import { enrichCandles } from '../indicators.js';

// Early entry: between trigger-candle closes, every closed cfg.earlyTf candle
// (5m by default) re-checks the setup against the trigger candle formed so
// far, so a pullback reclaim is bought within minutes instead of at the 4h (or
// daily) close.
// Closed trigger candles fed to the indicators with the forming one. 250 bars
// is plenty for EMA50/ATR14/ADX14 to converge.
const EARLY_WINDOW = 250;

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

function earlyProfile(profile, cfg) {
  return Boolean(cfg.earlyEntry) && Boolean(TF_MS[cfg.earlyTf]) && TF_MS[cfg.earlyTf] < TF_MS[profile.triggerTf];
}

// The trigger-timeframe candle formed so far, from the closed early candles
// since it opened up to and including sub[k].
function formingCandle(sub, k, tf) {
  const openMs = Math.floor((sub[k].time * 1000) / TF_MS[tf]) * TF_MS[tf];
  let m = k;
  while (m > 0 && sub[m - 1].time * 1000 >= openMs) m -= 1;
  const bar = { time: openMs / 1000, date: new Date(openMs).toISOString().slice(0, 10), open: sub[m].open, high: -Infinity, low: Infinity, close: sub[k].close, volume: 0 };
  for (let n = m; n <= k; n += 1) {
    bar.high = Math.max(bar.high, sub[n].high);
    bar.low = Math.min(bar.low, sub[n].low);
    bar.volume += sub[n].volume || 0;
  }
  return bar;
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
  for (const symbol of tradeSymbols) {
    for (const p of enabledProfiles(cfg)) {
      add(symbol, p.triggerTf);
      if (earlyProfile(p, cfg)) add(symbol, cfg.earlyTf);
      // A position opened during this pass needs its exit candles too.
      if (exitTfFor(p, cfg)) add(symbol, cfg.exitTf);
    }
  }
  for (const position of Object.values(portfolio.positions)) {
    const profile = profilesFor(cfg)[normalizePosition(position).profile];
    if (profile) add(position.symbol, profile.triggerTf);
    if (profile && exitTfFor(profile, cfg)) add(position.symbol, cfg.exitTf);
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
      const heldProfile = holding && profilesFor(cfg)[holding.profile];
      const managesHere = Boolean(heldProfile) && (heldProfile.triggerTf === tf || exitTfFor(heldProfile, cfg) === tf);
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
  if (!profile) return;
  const exitTf = exitTfFor(profile, cfg);
  if (event.tf === exitTf) {
    if (position.filledAtMs && event.closeMs <= position.filledAtMs) return;
    const bar = series[event.symbol][event.tf][event.i];
    const trig = series[event.symbol][profile.triggerTf];
    const ti = trig ? lastClosedIndex(trig, profile.triggerTf, event.closeMs) : -1;
    portfolio.positions[event.symbol] = position;
    const { fills, updates } = onExitBar(position, bar, profile, cfg, ti >= 0 ? trig[ti].atr14 : null);
    if (updates) Object.assign(position, updates);
    if (fills.length) applyFills(ctx, event.symbol, fills, bar);
    return;
  }
  if (profile.triggerTf !== event.tf) return;
  portfolio.positions[event.symbol] = position;
  let bar = series[event.symbol][event.tf][event.i];
  if (position.filledAtMs && bar.time * 1000 < position.filledAtMs) bar = afterFill(series[event.symbol][ctx.cfg.earlyTf], TF_MS[ctx.cfg.earlyTf], bar, position.filledAtMs, event.closeMs) || bar;
  // With exit candles on, the stop and target were already checked on them; the
  // trigger close only counts the bar, moves the trail and runs the time stop.
  const { fills, updates } = onBar(position, bar, profile, cfg, { priceExits: !exitTf || !series[event.symbol][exitTf] });
  if (updates) Object.assign(position, updates);
  if (fills.length) applyFills(ctx, event.symbol, fills, bar);
}

// The part of an early position's entry candle after the fill, so a low
// reached before the buy can't stop it out.
function afterFill(sub, subMs, bar, fromMs, toMs) {
  if (!sub) return null;
  const parts = sub.filter((b) => b.time * 1000 >= fromMs && b.time * 1000 + subMs <= toMs);
  if (!parts.length) return null;
  return {
    ...bar,
    open: parts[0].open,
    high: Math.max(...parts.map((b) => b.high)),
    low: Math.min(...parts.map((b) => b.low))
  };
}

// Same pullback test evaluatePullback() runs for a trigger candle at ci + 1,
// from the closed candles alone.
function pullbackSeen(trig, ci, cfg) {
  const p = cfg.setup;
  let touched = false;
  let minRsi = Infinity;
  for (let k = ci + 1 - p.pullbackLookback; k <= ci; k += 1) {
    const b = trig[k];
    if (!b || !Number.isFinite(b.low) || !Number.isFinite(b.ema20) || !Number.isFinite(b.atr14) || !Number.isFinite(b.rsi14) || b.atr14 <= 0) continue;
    if ((b.low - b.ema20) / b.atr14 <= p.pullbackTouchAtr) touched = true;
    minRsi = Math.min(minRsi, b.rsi14);
  }
  return touched && minRsi >= p.rsiDipMin && minRsi <= p.rsiDipMax;
}

// Setup check on the forming trigger candle at an early-candle close. Returns the
// evaluation with the forming candle's time, or null when there is nothing to check.
function evaluateEarly(ctx, event, profile) {
  const { series, cfg } = ctx;
  const trigAll = series[event.symbol][profile.triggerTf];
  const sub = series[event.symbol][cfg.earlyTf];
  if (!trigAll || event.closeMs % TF_MS[profile.triggerTf] === 0) return null; // the candle's own close is checked normally
  const ci = lastClosedIndex(trigAll, profile.triggerTf, event.closeMs);
  if (ci < 1) return null;
  const forming = formingCandle(sub, event.i, profile.triggerTf);
  if (!(forming.close > trigAll[ci].high)) return null; // cheap pre-checks first: no reclaim yet,
  if (!pullbackSeen(trigAll, ci, cfg)) return null; // or no pullback to buy
  const trig = enrichCandles(trigAll.slice(Math.max(0, ci - EARLY_WINDOW + 1), ci + 1).concat(forming));
  const filt = series[event.symbol][profile.filterTf];
  const j = lastClosedIndex(filt, profile.filterTf, event.closeMs);
  let btc = null;
  if (cfg.btcGate && series[BTC_SYMBOL]?.[profile.filterTf]) {
    const btcFilt = series[BTC_SYMBOL][profile.filterTf];
    btc = { filt: btcFilt, j: lastClosedIndex(btcFilt, profile.filterTf, event.closeMs) };
  }
  return { ...evaluateSetup({ trig, i: trig.length - 1, filt, j: j < 0 ? null : j, profile, cfg, btc }), barTime: forming.time };
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

// What out.signals carries for a candidate. entryPrice/stopPrice are the
// setup's plan before slippage, so outcomes.js can follow every signal.
function signalFields(c) {
  return {
    symbol: c.symbol, profile: c.profile.key, setup: c.setup, score: c.score, barTime: c.barTime,
    tf: c.tf, entryPrice: c.signal.entryPrice, stopPrice: c.signal.stopPrice
  };
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

    // Exit candles first: at a trigger close the 5m candle ending at the same
    // moment belongs to the price path before the close's own bookkeeping.
    const exitFirst = [...group].sort((a, b) => TF_MS[a.tf] - TF_MS[b.tf]);
    for (const event of exitFirst) manage(ctx, event);

    const riskEvent = updateRisk(state.risk, bookEquityIdr(portfolio), closeMs, cfg);
    if (riskEvent) out.riskEvents.push(riskEvent);
    const blocked = entryBlock(state.risk, closeMs, cfg);

    const candidates = [];
    for (const event of group) {
      if (!tradeSymbols.has(event.symbol) || portfolio.positions[event.symbol]) continue;
      const isLatest = event.i === series[event.symbol][event.tf].length - 1;
      for (const profile of enabledProfiles(cfg)) {
        const early = profile.triggerTf !== event.tf;
        if (early && !(event.tf === cfg.earlyTf && earlyProfile(profile, cfg))) continue;
        const evaluation = early ? evaluateEarly(ctx, event, profile) : evaluate(ctx, event, profile);
        if (!evaluation) continue;
        const barTime = early ? evaluation.barTime : series[event.symbol][event.tf][event.i].time;
        if (live && isLatest && !early) {
          (out.latestEvaluations[event.symbol] ||= {})[profile.key] = { ...evaluation, closeMs, barTime };
        }
        const signal = evaluation.signal;
        if (!signal) continue;
        // One decision per trigger candle: once a forming candle has signalled
        // early, its later 15m checks and its own close stay quiet.
        const sState = symbolState(state, event.symbol);
        sState.earlyBarTime ||= {};
        if (sState.earlyBarTime[profile.key] === barTime) continue;
        if (early) sState.earlyBarTime[profile.key] = barTime;
        const base = {
          symbol: event.symbol, profile: profile.key, setup: signal.setup, score: signal.score, barTime,
          tf: profile.triggerTf, entryPrice: signal.entryPrice, stopPrice: signal.stopPrice
        };
        const cooldownUntil = sState.cooldownUntilMs[profile.key];
        // An early fill is priced at that candle's close, so it goes stale after two of them.
        const maxDelayMs = early ? 2 * TF_MS[event.tf] : cfg.maxEntryDelayBarFrac * TF_MS[event.tf];
        let skip = null;
        if (live && !isLatest) skip = 'missed-stale';
        else if (live && nowMs - closeMs > maxDelayMs) skip = 'missed-late: tick ran too long after the bar closed';
        else if (signal.score < cfg.minConfidencePct) skip = `score ${signal.score} below ${cfg.minConfidencePct}`;
        else if (blocked) skip = `entries paused: ${blocked}`;
        else if (cooldownUntil && closeMs < cooldownUntil) skip = 'cooldown after stop-out';
        if (skip) { out.signals.push({ ...base, taken: false, skip }); continue; }
        candidates.push({ ...base, signal, event, profile, early });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    let opened = 0;
    for (const c of candidates) {
      let skip = null;
      if (portfolio.positions[c.symbol]) skip = 'already holding';
      else if (opened >= cfg.maxNewEntriesPerBar) skip = `max ${cfg.maxNewEntriesPerBar} new entry per bar close`;
      else if (Object.keys(portfolio.positions).length >= cfg.maxOpenPositions) skip = `max ${cfg.maxOpenPositions} open positions`;
      const entryPrice = c.signal.entryPrice * (1 + cfg.slippagePct / 100);
      let sized = null;
      if (!skip) {
        sized = sizePosition({ portfolio, entryPrice, stopPrice: c.signal.stopPrice, usdIdrRate, cfg });
        if (!(sized.qty > 0)) skip = sized.reason;
      }
      if (skip) { out.signals.push({ ...signalFields(c), taken: false, skip }); continue; }
      const bar = series[c.symbol][c.event.tf][c.event.i];
      const { transaction, note } = openPositionQty(portfolio, {
        symbol: c.symbol, profile: c.profile.key, setup: c.setup, quantity: sized.qty, entryPrice,
        stopPrice: c.signal.stopPrice, riskIdr: sized.riskIdr, score: c.score,
        reason: c.early ? `${c.signal.reason} Bought early on a ${cfg.earlyTf} check, before the ${c.profile.triggerTf} close.` : c.signal.reason,
        timeMs: ctx.timeFor(bar), barTime: c.barTime, usdIdrRate, roundTripCostPct: cfg.roundTripCostPct,
        keepAllTransactions: ctx.keepAll
      });
      out.signals.push({ ...signalFields(c), taken: Boolean(transaction), skip: transaction ? null : note });
      if (transaction) {
        if (c.early) portfolio.positions[c.symbol].filledAtMs = closeMs;
        out.transactions.push(transaction);
        opened += 1;
      }
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
