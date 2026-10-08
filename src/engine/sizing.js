// Money is IDR, prices are USDT. All functions are pure.

// Equity at cost basis: cash plus what is tied up in open positions. Used for
// sizing and risk limits so they move with realized results, not intrabar noise.
export function bookEquityIdr(portfolio) {
  return portfolio.balanceIdr + Object.values(portfolio.positions || {}).reduce((s, p) => s + (p.investedIdr || 0), 0);
}

export function openRiskIdr(portfolio, usdIdrRate) {
  return Object.values(portfolio.positions || {}).reduce((sum, p) => {
    const perUnit = p.entryPrice - p.stopPrice;
    return perUnit > 0 ? sum + perUnit * p.quantity * usdIdrRate : sum;
  }, 0);
}

export function sizePosition({ portfolio, entryPrice, stopPrice, usdIdrRate, cfg }) {
  if (!(entryPrice > stopPrice) || !(stopPrice > 0)) return { qty: 0, reason: 'invalid stop' };
  const equity = bookEquityIdr(portfolio);
  const riskBudget = equity * cfg.riskPerTradePct / 100;
  const portfolioRoom = equity * cfg.maxPortfolioRiskPct / 100 - openRiskIdr(portfolio, usdIdrRate);
  const riskIdr = Math.min(riskBudget, portfolioRoom);
  if (!(riskIdr > 0)) return { qty: 0, reason: `portfolio risk cap (${cfg.maxPortfolioRiskPct}%) reached` };

  const costPerUnit = entryPrice * cfg.roundTripCostPct / 100;
  let qty = riskIdr / ((entryPrice - stopPrice + costPerUnit) * usdIdrRate);
  const entryFeeFactor = 1 + cfg.roundTripCostPct / 200;
  const capIdr = Math.min(cfg.tradeAllocationPct * equity, portfolio.balanceIdr);
  const notionalIdr = qty * entryPrice * usdIdrRate * entryFeeFactor;
  if (notionalIdr > capIdr) qty = capIdr / (entryPrice * usdIdrRate * entryFeeFactor);
  if (qty * entryPrice < cfg.minNotionalUsdt) return { qty: 0, reason: 'position below minimum size' };

  const actualRiskIdr = qty * (entryPrice - stopPrice + costPerUnit) * usdIdrRate;
  return { qty, riskIdr: actualRiskIdr, capped: notionalIdr > capIdr };
}
