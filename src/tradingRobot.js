import { readJson, writeJson } from './storage.js';

const STATE_FILE = 'portfolio.json';

// Paper trading only. This module never talks to Binance's order endpoints or
// any account - it simulates fills at the live price already fetched by
// marketData.js against a single shared IDR balance, exactly like
// robotrader's tradingRobot.js does for BBCA, just extended to hold several
// coin positions at once out of one balance pool instead of one stock.
//
// Every function below takes an explicit `cfg` (initialBalanceIdr,
// tradeAllocationPct, maxOpenPositions, roundTripCostPct, usdIdrRate) instead
// of reading a module-level config object - these are DB-backed settings now
// (see settings.js), read fresh per request, so a change in Settings takes
// effect on the very next refresh with no restart. Matches the same
// explicit-cfg convention scripts/benchmark.mjs already used for its own
// parallel portfolio simulation.

function defaultState(cfg) {
  return {
    balanceIdr: cfg.initialBalanceIdr,
    initialBalanceIdr: cfg.initialBalanceIdr,
    realizedProfitIdr: 0,
    positions: {},
    transactions: [],
    updatedAt: new Date().toISOString()
  };
}

export async function getPortfolio(cfg) {
  return readJson(STATE_FILE, defaultState(cfg));
}

async function savePortfolio(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(STATE_FILE, state);
  return state;
}

export async function openPosition({ symbol, mode, entryPrice, stopPrice, targetPrice, maxHoldUntil, reason }, cfg) {
  const state = await getPortfolio(cfg);
  if (state.positions[symbol]) return { state, transaction: null, note: 'Already holding this symbol.' };
  if (Object.keys(state.positions).length >= cfg.maxOpenPositions) {
    return { state, transaction: null, note: `Max concurrent positions (${cfg.maxOpenPositions}) reached.` };
  }

  const spendIdr = Math.min(state.balanceIdr * cfg.tradeAllocationPct, state.balanceIdr);
  if (!(spendIdr > 0)) return { state, transaction: null, note: 'Insufficient balance.' };
  const spendUsdt = spendIdr / cfg.usdIdrRate;
  const entryCostFactor = 1 - cfg.roundTripCostPct / 100 / 2; // half the round-trip cost on entry
  const quantity = (spendUsdt * entryCostFactor) / entryPrice;
  if (!(quantity > 0)) return { state, transaction: null, note: 'Computed zero quantity - price or balance too small.' };

  state.balanceIdr = round2(state.balanceIdr - spendIdr);
  state.positions[symbol] = {
    symbol, mode, quantity, entryPrice,
    stopPrice: stopPrice ?? null,
    // Trailing-stop bookkeeping: the highest price seen since entry, used by
    // evaluateExit (decisionEngine.js) to ratchet stopPrice up over time
    // instead of leaving it fixed at the entry-time ATR stop. Starts at
    // entryPrice - a position can't trail below its own entry on day one.
    highWaterMark: entryPrice,
    targetPrice: targetPrice ?? null,
    maxHoldUntil: maxHoldUntil ?? null,
    investedIdr: spendIdr,
    investedUsdt: spendUsdt,
    openedAt: new Date().toISOString(),
    reason: reason || ''
  };

  const transaction = {
    id: txId(), type: 'BUY', symbol, mode, quantity, price: entryPrice,
    spendIdr, reason: reason || '', balanceAfterIdr: state.balanceIdr, createdAt: new Date().toISOString()
  };
  state.transactions.unshift(transaction);
  state.transactions = state.transactions.slice(0, 300);
  await savePortfolio(state);
  return { state, transaction };
}

// Persists the ratcheted trailing-stop fields onto a still-open position
// without touching balance/transactions - called every refresh tick from
// robotEngine.js's applyRefresh so next tick's trail starts from where this
// one left off, not from the original entry stop. A no-op if the position
// closed between the caller's read and this write (e.g. a concurrent manual
// sell), matching openPosition/closePosition's own re-read-then-mutate style.
export async function updatePositionTrailing(symbol, { stopPrice, highWaterMark }, cfg) {
  const state = await getPortfolio(cfg);
  const position = state.positions[symbol];
  if (!position) return { state, updated: false };
  if (Number.isFinite(stopPrice)) position.stopPrice = stopPrice;
  if (Number.isFinite(highWaterMark)) position.highWaterMark = highWaterMark;
  await savePortfolio(state);
  return { state, updated: true };
}

export async function closePosition({ symbol, exitPrice, reason }, cfg) {
  const state = await getPortfolio(cfg);
  const position = state.positions[symbol];
  if (!position) return { state, transaction: null, note: 'No open position for this symbol.' };

  const grossUsdt = position.quantity * exitPrice;
  const exitCostFactor = 1 - cfg.roundTripCostPct / 100 / 2;
  const netUsdt = grossUsdt * exitCostFactor;
  const netIdr = netUsdt * cfg.usdIdrRate;
  const realizedProfitIdr = round2(netIdr - position.investedIdr);

  state.balanceIdr = round2(state.balanceIdr + netIdr);
  state.realizedProfitIdr = round2((state.realizedProfitIdr || 0) + realizedProfitIdr);
  delete state.positions[symbol];

  const transaction = {
    id: txId(), type: 'SELL', symbol, mode: position.mode, quantity: position.quantity,
    price: exitPrice, entryPrice: position.entryPrice, proceedsIdr: round2(netIdr),
    realizedProfitIdr, reason: reason || '', balanceAfterIdr: state.balanceIdr, createdAt: new Date().toISOString()
  };
  state.transactions.unshift(transaction);
  state.transactions = state.transactions.slice(0, 300);
  await savePortfolio(state);
  return { state, transaction };
}

// Attaches live mark-to-market fields (current price, unrealized P&L, total
// equity/return) without mutating the persisted state - same pattern as
// robotrader's markPortfolioToMarket.
export function markToMarket(state, prices, cfg) {
  const output = JSON.parse(JSON.stringify(state));
  let positionsValueIdr = 0;
  for (const [symbol, position] of Object.entries(output.positions || {})) {
    const price = prices[symbol];
    if (!Number.isFinite(price)) continue;
    const marketIdr = position.quantity * price * cfg.usdIdrRate;
    position.currentPrice = price;
    position.marketValueIdr = round2(marketIdr);
    position.unrealizedProfitIdr = round2(marketIdr - position.investedIdr);
    position.unrealizedProfitPct = position.investedIdr > 0
      ? round2((position.unrealizedProfitIdr / position.investedIdr) * 100) : 0;
    positionsValueIdr += marketIdr;
  }
  output.equityIdr = round2(output.balanceIdr + positionsValueIdr);
  output.totalReturnPct = output.initialBalanceIdr > 0
    ? round2(((output.equityIdr - output.initialBalanceIdr) / output.initialBalanceIdr) * 100) : 0;
  return output;
}

function txId() {
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
