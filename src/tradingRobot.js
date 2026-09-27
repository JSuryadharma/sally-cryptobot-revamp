// Paper trading only: nothing here talks to Binance order endpoints. The
// portfolio math lives in src/engine/ledger.js (shared with the engine and the
// backtester); this module only loads and saves the stored portfolio.
import { readJson } from './storage.js';
import { createPortfolio, markToMarket as ledgerMarkToMarket } from './engine/ledger.js';

export const PORTFOLIO_KEY = 'portfolio.json';

export async function getPortfolio({ initialBalanceIdr }) {
  return readJson(PORTFOLIO_KEY, createPortfolio(initialBalanceIdr));
}

export function markToMarket(portfolio, prices, usdIdrRate) {
  return ledgerMarkToMarket(portfolio, prices, usdIdrRate);
}
