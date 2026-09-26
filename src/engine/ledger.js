// Pure paper-portfolio bookkeeping, shared by the live engine, manual trades
// and the backtester. Transaction fields used by the daily email check
// (createdAt/type/symbol/price/reason/realizedProfitIdr) are kept as before.

const MAX_TRANSACTIONS = 300;

function round2(v) { return Math.round(v * 100) / 100; }

export function createPortfolio(initialBalanceIdr) {
  return {
    balanceIdr: initialBalanceIdr,
    initialBalanceIdr,
    realizedProfitIdr: 0,
    positions: {},
    transactions: [],
    updatedAt: new Date().toISOString()
  };
}

function newId(prefix, time) {
  return `${prefix}_${time}_${Math.random().toString(36).slice(2, 8)}`;
}

function record(portfolio, tx, keepAll) {
  portfolio.transactions.unshift(tx);
  if (!keepAll) portfolio.transactions = portfolio.transactions.slice(0, MAX_TRANSACTIONS);
}

// Older positions (pre-v2 engine) lack the management fields; fill them in so
// they are managed like any other position.
export function normalizePosition(position) {
  if (position.initialStop != null && position.tradeId) return position;
  const profile = position.profile || (position.mode === 'swing' ? 'swing' : 'scalping');
  const initialStop = Number.isFinite(position.stopPrice) && position.stopPrice < position.entryPrice
    ? position.stopPrice
    : position.entryPrice * 0.98;
  return {
    ...position,
    profile,
    mode: profile,
    stopPrice: Number.isFinite(position.stopPrice) ? position.stopPrice : initialStop,
    initialStop,
    initialQuantity: position.initialQuantity ?? position.quantity,
    highWaterMark: position.highWaterMark ?? position.entryPrice,
    barsHeld: position.barsHeld ?? 0,
    partialTaken: position.partialTaken ?? false,
    mfeR: position.mfeR ?? 0,
    riskIdr: position.riskIdr ?? null,
    realizedSoFarIdr: position.realizedSoFarIdr ?? 0,
    tradeId: position.tradeId || newId('trade', Date.parse(position.openedAt) || 0)
  };
}

export function openPositionQty(portfolio, {
  symbol, profile, setup, quantity, entryPrice, stopPrice, riskIdr, score, reason,
  timeMs, barTime, usdIdrRate, roundTripCostPct, keepAllTransactions = false
}) {
  if (portfolio.positions[symbol]) return { transaction: null, note: 'Already holding this symbol.' };
  const grossIdr = quantity * entryPrice * usdIdrRate;
  const spendIdr = round2(grossIdr * (1 + roundTripCostPct / 200));
  if (!(quantity > 0) || spendIdr > portfolio.balanceIdr + 0.01) return { transaction: null, note: 'Insufficient balance.' };

  const tradeId = newId('trade', timeMs);
  portfolio.balanceIdr = round2(portfolio.balanceIdr - spendIdr);
  portfolio.positions[symbol] = {
    symbol, mode: profile, profile, setup, quantity, initialQuantity: quantity, entryPrice,
    stopPrice, initialStop: stopPrice, highWaterMark: entryPrice,
    targetPrice: null, maxHoldUntil: null,
    investedIdr: spendIdr, investedUsdt: round2(spendIdr / usdIdrRate),
    openedAt: new Date(timeMs).toISOString(), openedBarTime: barTime,
    barsHeld: 0, partialTaken: false, mfeR: 0, riskIdr: round2(riskIdr), realizedSoFarIdr: 0,
    tradeId, score, reason: reason || ''
  };
  const transaction = {
    id: newId('tx', timeMs), tradeId, type: 'BUY', symbol, mode: profile, profile, setup,
    quantity, price: entryPrice, stopPrice, spendIdr, riskIdr: round2(riskIdr), confidencePct: score,
    reason: reason || '', balanceAfterIdr: portfolio.balanceIdr,
    createdAt: new Date(timeMs).toISOString(), barTime
  };
  record(portfolio, transaction, keepAllTransactions);
  return { transaction };
}

// Sells `quantity` (all of it when omitted). Partial sells keep the position
// open with a proportionally reduced cost basis.
export function sellPosition(portfolio, {
  symbol, quantity, price, reason, exitKind, timeMs, barTime, usdIdrRate, roundTripCostPct, keepAllTransactions = false
}) {
  const position = portfolio.positions[symbol];
  if (!position) return { transaction: null, note: 'No open position for this symbol.' };
  const qty = Math.min(quantity ?? position.quantity, position.quantity);
  const closesAll = qty >= position.quantity * (1 - 1e-9);
  const netIdr = qty * price * usdIdrRate * (1 - roundTripCostPct / 200);
  const basisIdr = closesAll ? position.investedIdr : position.investedIdr * (qty / position.quantity);
  const realizedProfitIdr = round2(netIdr - basisIdr);

  portfolio.balanceIdr = round2(portfolio.balanceIdr + netIdr);
  portfolio.realizedProfitIdr = round2((portfolio.realizedProfitIdr || 0) + realizedProfitIdr);
  const tradeRealizedIdr = round2((position.realizedSoFarIdr || 0) + realizedProfitIdr);

  const transaction = {
    id: newId('tx', timeMs), tradeId: position.tradeId, type: 'SELL', symbol,
    mode: position.profile, profile: position.profile, setup: position.setup,
    quantity: qty, price, entryPrice: position.entryPrice, proceedsIdr: round2(netIdr),
    realizedProfitIdr, reason: reason || '', exitKind, partial: !closesAll,
    balanceAfterIdr: portfolio.balanceIdr, createdAt: new Date(timeMs).toISOString(), barTime,
    openedAt: position.openedAt
  };
  if (closesAll) {
    transaction.tradeRealizedIdr = tradeRealizedIdr;
    transaction.rMultiple = position.riskIdr > 0 ? Math.round((tradeRealizedIdr / position.riskIdr) * 100) / 100 : null;
    delete portfolio.positions[symbol];
  } else {
    position.quantity -= qty;
    position.investedIdr = round2(position.investedIdr - basisIdr);
    position.investedUsdt = round2(position.investedIdr / usdIdrRate);
    position.realizedSoFarIdr = tradeRealizedIdr;
  }
  record(portfolio, transaction, keepAllTransactions);
  return { transaction, closed: closesAll, tradeRealizedIdr };
}

export function markToMarket(state, prices, usdIdrRate) {
  const output = JSON.parse(JSON.stringify(state));
  let positionsValueIdr = 0;
  for (const [symbol, position] of Object.entries(output.positions || {})) {
    const price = prices[symbol];
    if (!Number.isFinite(price)) {
      positionsValueIdr += position.investedIdr || 0;
      continue;
    }
    const marketIdr = position.quantity * price * usdIdrRate;
    position.currentPrice = price;
    position.marketValueIdr = round2(marketIdr);
    position.unrealizedProfitIdr = round2(marketIdr - position.investedIdr);
    position.unrealizedProfitPct = position.investedIdr > 0 ? round2((position.unrealizedProfitIdr / position.investedIdr) * 100) : 0;
    positionsValueIdr += marketIdr;
  }
  output.equityIdr = round2(output.balanceIdr + positionsValueIdr);
  output.totalReturnPct = output.initialBalanceIdr > 0
    ? round2(((output.equityIdr - output.initialBalanceIdr) / output.initialBalanceIdr) * 100) : 0;
  return output;
}
