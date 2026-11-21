// Starting balance changes (Settings > Starting balance) act as a deposit or a
// withdrawal on the shared cash: open positions and history stay, cash moves by
// the difference, and the risk brakes' reference equities move with it so a
// withdrawal doesn't read as a drawdown. Runs inside the engine pass (under the
// engine lease), before any trading.
export function syncStartingBalance(portfolio, target, riskStates = []) {
  if (!portfolio || !(target > 0) || !(portfolio.initialBalanceIdr > 0)) return 0;
  const delta = target - portfolio.initialBalanceIdr;
  if (!delta) return 0;
  portfolio.balanceIdr += delta;
  portfolio.initialBalanceIdr = target;
  portfolio.deposits = [...(portfolio.deposits || []), { at: new Date().toISOString(), amountIdr: delta, startingBalanceIdr: target }].slice(-50);
  for (const risk of riskStates) {
    if (!risk) continue;
    if (Number.isFinite(risk.peakEquityIdr)) risk.peakEquityIdr += delta;
    if (Number.isFinite(risk.dayStartEquityIdr)) risk.dayStartEquityIdr += delta;
  }
  return delta;
}
