// Ties the pieces together per coin: fetch data -> pick a mode -> decide ->
// simulate the fill -> notify. Called on a timer for every watchlist symbol
// (see server.js), and on demand when the UI requests a manual refresh.
//
// Split into two phases so refreshAll() can fetch data in parallel (the slow
// part - Binance network calls per symbol) while still applying the trading
// decision one symbol at a time (the part that's unsafe to parallelize):
// openPosition()/closePosition() in tradingRobot.js do a read-entire-state,
// mutate, write-entire-state cycle with no locking, so two symbols
// concurrently opening a position could both read the same starting balance
// and silently clobber each other's write. Fetching is read-only and has no
// such risk.
import { loadAllModes } from './marketData.js';
import { STRATEGY_PARAMS, RR_TEMPLATES, describeStrategyParams, describeNearCondition } from './decisionEngine.js';
import { recommendMode, getMarketSummary } from './aiAdvisor.js';
import { getPortfolio, openPosition, closePosition, updatePositionTrailing } from './tradingRobot.js';
import { readSettings } from './settings.js';
import { resolveUsdIdrRate } from './binanceData.js';
// 2026-09 revamp ladder (see the delivered "Robocrypto Revamp" report):
// bar-deduped combined-retest entry + structured (CHoCH/spike-stop) exit
// from liveStrategy.js, and portfolio-level risk breakers from
// riskManager.js, both persisted via strategyState.js. decisionEngine.js's
// own evaluateEntry/evaluateExit are left untouched and still exported for
// anything else that wants the plain baseline behavior (e.g. a manual-buy
// route) - this file just no longer calls them itself.
import { getStrategyState, saveStrategyState } from './strategyState.js';
import { tickRisk, recordTradeOutcome } from './riskManager.js';
import { evaluateLiveEntry, evaluateLiveExit } from './liveStrategy.js';

// Same fields tradingRobot.js's cfg-taking functions need, sourced from the
// DB-backed settings instead of a module-level config object - read fresh
// per refresh, so a Settings change takes effect on the very next tick.
// usdIdrRate is live-fetched from Binance's own USDT/IDR pair (see
// binanceData.js's resolveUsdIdrRate) rather than read straight off
// settings - settings.usdIdrRate is now only the fallback used if that
// live fetch fails, not the primary source.
export async function portfolioCfg(settings) {
  return {
    initialBalanceIdr: settings.initialBalanceIdr,
    tradeAllocationPct: settings.tradeAllocationPct,
    maxOpenPositions: settings.maxOpenPositions,
    roundTripCostPct: settings.roundTripCostPct,
    usdIdrRate: await resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl)
  };
}

// Phase 1 - read-only, safe to run for every symbol at once.
async function prepareRefresh(symbol, { force = false } = {}) {
  const settings = await readSettings();
  const modes = await loadAllModes(symbol, { force, baseUrl: settings.binanceBaseUrl });
  // recommendMode reads .latest off each mode - use the settled candle
  // (closedLatest, see marketData.js) so the regime pick can't flip back and
  // forth on the same still-forming-candle noise the entry/exit gates below
  // are guarded against, independent of which mode ends up active.
  const recommendation = recommendMode({
    swing: { latest: modes.swing.closedLatest },
    scalping: { latest: modes.scalping.closedLatest }
  });
  const portfolio = await getPortfolio(await portfolioCfg(settings));
  const position = portfolio.positions[symbol];
  // A pinned mode (Settings > Strategy mode) only decides which mode is used
  // to open a NEW position - a coin already holding one keeps trading under
  // whatever mode it was bought under (see applyRefresh below), so pinning
  // never silently moves a live trade's stop/target.
  const modeOverride = settings.autoTrade.modeOverride;
  const overrideActive = Boolean(modeOverride && STRATEGY_PARAMS[modeOverride] && !position);
  const activeMode = overrideActive ? modeOverride : recommendation.mode;
  const snapshot = modes[activeMode];
  return { symbol, modes, recommendation, activeMode, modeOverride: overrideActive ? modeOverride : null, snapshot, position, settings };
}

// Phase 2 - decides and, if a trade fires, mutates the shared portfolio.
// Must run one symbol at a time across a batch (see refreshAll below).
async function applyRefresh({ symbol, modes, recommendation, activeMode, modeOverride, snapshot, position, settings }, { notifications, broadcast } = {}) {
  const cfg = await portfolioCfg(settings);
  const autoTradeOn = settings.autoTrade.enabled;
  const minConfidencePct = settings.autoTrade.minConfidencePct;
  const rrMultiple = RR_TEMPLATES[settings.autoTrade.riskRewardTemplate]?.ratio ?? RR_TEMPLATES.balanced.ratio;

  // v4 portfolio risk management + the persisted state backing v2/v3/v6's
  // stateful entry/exit logic (see strategyState.js, riskManager.js,
  // liveStrategy.js). Loaded fresh each call and saved back at the end of
  // this function, right alongside the portfolio/position writes below - so
  // a symbol's retest/structure/risk bookkeeping is never more than one
  // applyRefresh call stale. tickRisk is checked against the CURRENT
  // balance every time this runs (once per symbol per refresh cycle, not
  // once per external tick the way the benchmark ticked) - harmless to run
  // more often than the benchmark did, since a breaker that's already
  // tripped just stays tripped on repeat calls, and an untripped one only
  // evaluates the current balance snapshot either way.
  const strategyState = await getStrategyState();
  const portfolioNow = await getPortfolio(cfg);
  const { haltedUntilMs, haltReason } = tickRisk(strategyState.risk, portfolioNow.balanceIdr);
  const entriesHalted = Boolean(haltedUntilMs);

  let entryOrExit;
  let transaction = null;
  let nearCondition;

  if (position) {
    // A coin keeps trading under the mode it was BOUGHT under, even if the
    // regime picker's recommendation later shifts - switching a live
    // position's rules mid-trade would silently move its stop/target.
    const heldSnapshot = modes[position.mode] || snapshot;
    // Decide off the settled candle, not the live/still-forming one - see
    // marketData.js's closedCandles comment for why: evaluateExit's stop/
    // target/max-hold/trend-exit checks assume "the latest candle" is a
    // final, once-per-bar reading, so feeding it a candle that's still
    // changing lets an ordinary intrabar wick trip the stop before the bar
    // that supposedly triggered it has actually closed.
    //
    // v3: structured exit (CHoCH trend-exit + spike-confirmed stop) instead
    // of decisionEngine.js's plain EMA-cross exit, run through liveStrategy's
    // bar-dedup wrapper (see its header comment for why that guard exists on
    // a continuously-polled live app). structureCandles is the SWING/daily
    // series regardless of which mode this position is actually trading on -
    // structure is deliberately checked on the higher timeframe, matching
    // how the benchmark's own v3/v6 profiles did it.
    entryOrExit = evaluateLiveExit(
      strategyState.exit, symbol, heldSnapshot.closedCandles, position, position.mode,
      modes.swing.closedCandles,
      { useChoch: true, spikeAtrMult: 1.0, swingLookback: 6 }
    );
    // evaluateExit returns the ratcheted trailing-stop values without
    // mutating `position` itself - build a display copy so the "how close
    // to stop/target" card reflects this tick's trailed stop immediately,
    // not the stale one from before this refresh persisted it below.
    const trailingChanged = Number.isFinite(entryOrExit.stopPrice)
      && (entryOrExit.stopPrice !== position.stopPrice || entryOrExit.highWaterMark !== position.highWaterMark);
    const positionForDisplay = trailingChanged
      ? { ...position, stopPrice: entryOrExit.stopPrice, highWaterMark: entryOrExit.highWaterMark }
      : position;
    nearCondition = describeNearCondition(heldSnapshot.closedCandles, position.mode, positionForDisplay);
    // Exits are never confidence-gated - see the note in settings.js.
    if (entryOrExit.action === 'SELL' && autoTradeOn) {
      // Fill at the same settled candle's close the SELL decision (and its
      // reason string, e.g. "Stop-loss hit at X") was actually computed
      // against - not heldSnapshot.latest, which can be a different,
      // still-live price by the time this executes.
      const exitPrice = heldSnapshot.closedLatest?.close ?? heldSnapshot.latest.close;
      const result = await closePosition({ symbol, exitPrice, reason: entryOrExit.reason }, cfg);
      transaction = result.transaction;
      entryOrExit.executed = Boolean(transaction);
      if (transaction) {
        // v4: feed the realized outcome into the consecutive-loss counter
        // regardless of whether notifications happen to be configured -
        // this bookkeeping must never depend on Telegram/notify settings.
        recordTradeOutcome(strategyState.risk, transaction.realizedProfitIdr);
      }
      if (transaction && notifications) {
        const pnl = Math.round(transaction.realizedProfitIdr).toLocaleString('id-ID');
        await notifications.notify({
          title: `SELL ${symbol}`,
          message: `${entryOrExit.reason} Realized P&L: Rp ${pnl}.`,
          level: transaction.realizedProfitIdr >= 0 ? 'success' : 'warning',
          category: 'trade'
        });
      }
    } else if (trailingChanged) {
      // Nothing executed this tick (still HOLD, or autoTrade is toggled off
      // even though a stop/target technically hit) - persist the ratcheted
      // stop/high-water-mark anyway so the NEXT tick trails from here, not
      // from the original entry stop. Pure bookkeeping, not a trade.
      await updatePositionTrailing(symbol, { stopPrice: entryOrExit.stopPrice, highWaterMark: entryOrExit.highWaterMark }, cfg);
    }
  } else if (entriesHalted) {
    // v4: a tripped portfolio risk breaker blocks NEW entries only - it
    // never reaches the branch above, so an already-open position's
    // stop/target/CHoCH exit logic is completely unaffected by a halt.
    entryOrExit = { action: 'HOLD', reason: `New entries paused - ${haltReason}`, confidencePct: 0 };
    nearCondition = describeNearCondition(snapshot.closedCandles, activeMode, null);
  } else {
    // Same reasoning as the exit branch above: a "fresh EMA cross" should
    // mean one that actually held through a candle close, not one glimpsed
    // mid-bar that might not survive to the close - see marketData.js.
    //
    // v2 (combined EMA-retest/BB-retest entry) + v6 (independent daily
    // direction filter), run through liveStrategy's bar-dedup wrapper.
    // dailySnap is the SWING (daily) closed snapshot regardless of which
    // mode would actually open the trade - direction is deliberately
    // checked on the higher timeframe, never the same fast candles as the
    // entry trigger itself.
    entryOrExit = evaluateLiveEntry(
      strategyState.entry, `${symbol}:${activeMode}`, snapshot.closedCandles, activeMode,
      { latest: modes.swing.closedLatest }, { rrMultiple }
    );
    nearCondition = describeNearCondition(snapshot.closedCandles, activeMode, null);
    const confidenceOk = entryOrExit.confidencePct >= minConfidencePct;
    if (entryOrExit.action === 'BUY' && autoTradeOn && confidenceOk) {
      const result = await openPosition({
        symbol, mode: activeMode,
        entryPrice: entryOrExit.entryPrice, stopPrice: entryOrExit.stopPrice,
        targetPrice: entryOrExit.targetPrice, maxHoldUntil: entryOrExit.maxHoldUntil,
        reason: entryOrExit.reason
      }, cfg);
      transaction = result.transaction;
      entryOrExit.executed = Boolean(transaction);
      if (transaction && notifications) {
        await notifications.notify({
          title: `BUY ${symbol}`,
          message: `${entryOrExit.reason} Confidence ${entryOrExit.confidencePct}% (${STRATEGY_PARAMS[activeMode].label}).`,
          level: 'info',
          category: 'trade'
        });
      }
    } else if (entryOrExit.action === 'BUY' && !confidenceOk) {
      // A real signal fired but didn't clear the user's own confidence bar -
      // report it transparently rather than silently downgrading to HOLD, so
      // the UI can show "signal seen, not taken" instead of nothing at all.
      entryOrExit.executed = false;
      entryOrExit.reason = `${entryOrExit.reason} Confidence ${entryOrExit.confidencePct}% is below your ${minConfidencePct}% threshold - not executed.`;
    }
  }

  // Persist the entry/exit/risk state this call advanced - same Postgres KV
  // store as portfolio.json/settings.json (see storage.js), separate key so
  // it never collides with either.
  await saveStrategyState(strategyState);

  const summary = await getMarketSummary({ symbol, snapshot, recommendation, entryOrExit, aiSettings: settings.ai });
  const payload = {
    symbol, recommendation, activeMode, modeOverride, entryOrExit, transaction, summary,
    latest: snapshot.latest,
    // Recent closes for the active mode only (not all three) - cheap, since
    // enrichCandles() already computed the full series in loadAllModes() and
    // this just slices it, but keeps the polled-every-8s /api/coins payload
    // small. Powers the row-list sparklines in the UI.
    sparkline: (snapshot.candles || []).slice(-24).map((c) => c.close),
    minConfidencePct, riskRewardTemplate: settings.autoTrade.riskRewardTemplate,
    strategyParams: describeStrategyParams(activeMode, rrMultiple),
    nearCondition,
    modes: {
      swing: lightSnapshot(modes.swing),
      scalping: lightSnapshot(modes.scalping),
      dayTrade: lightSnapshot(modes.dayTrade)
    }
  };

  if (broadcast) broadcast({ type: 'coin-update', payload });
  return payload;
}

function lightSnapshot(snapshot) {
  return { mode: snapshot.mode, interval: snapshot.interval, latest: snapshot.latest, fetchedAt: snapshot.fetchedAt };
}

export async function refreshSymbol(symbol, ctx = {}) {
  const prepared = await prepareRefresh(symbol, ctx);
  return applyRefresh(prepared, ctx);
}

export async function refreshAll(symbols, ctx) {
  // Phase 1: fetch every symbol's data at once - this is the actual
  // bottleneck (a Binance round trip per symbol), and it's read-only so
  // there's nothing to race. Brought an 8-symbol refresh from ~15-20s
  // (sequential) down to roughly the time of the single slowest symbol.
  const prepared = await Promise.all(
    symbols.map((symbol) => prepareRefresh(symbol, ctx).catch((error) => ({ symbol, error: error.message })))
  );

  // Phase 2: apply decisions one symbol at a time - this is where a trade
  // can mutate the shared portfolio balance, so it stays sequential exactly
  // like the original all-in-one loop did.
  const results = [];
  for (const item of prepared) {
    if (item.error) { results.push(item); continue; }
    try {
      results.push(await applyRefresh(item, ctx));
    } catch (error) {
      results.push({ symbol: item.symbol, error: error.message });
    }
  }
  return results;
}
