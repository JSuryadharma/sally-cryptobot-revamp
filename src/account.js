// One paper account, one cash pool, two trading books: crypto and IDX stocks.
//
// The stored portfolio keeps its old shape for crypto (portfolio.positions),
// so existing data needs no migration. IDX positions live in
// portfolio.books.idx.positions. Cash (balanceIdr), the transaction list and
// the account's total realized P&L are shared.
//
// bookView(portfolio, market) gives the engine and the ledger a portfolio-shaped
// object for one market: its own positions, the shared cash, and the other
// books' invested money and open risk (sizing.js adds those, so position
// sizing and the risk brakes see the whole account). Writes go straight
// through to the stored portfolio.
export const MARKETS = ['crypto', 'idx'];

export function ensureBooks(portfolio) {
  portfolio.positions ||= {};
  portfolio.books ||= {};
  portfolio.books.idx ||= { positions: {}, realizedProfitIdr: 0 };
  portfolio.books.idx.positions ||= {};
  return portfolio;
}

export function positionsOf(portfolio, market) {
  ensureBooks(portfolio);
  return market === 'crypto' ? portfolio.positions : portfolio.books[market].positions;
}

function investedOf(positions) {
  return Object.values(positions).reduce((s, p) => s + (p.investedIdr || 0), 0);
}

// Open risk at entry, scaled down after partial sells. Stops never move up in
// the current exits (no trail, no breakeven), so this matches the stop distance.
function openRiskOf(positions) {
  return Object.values(positions).reduce((s, p) => {
    if (!(p.riskIdr > 0) || !(p.entryPrice > p.stopPrice)) return s;
    const share = p.initialQuantity > 0 ? p.quantity / p.initialQuantity : 1;
    return s + p.riskIdr * share;
  }, 0);
}

function realizedOf(portfolio, market) {
  const idx = portfolio.books.idx.realizedProfitIdr || 0;
  return market === 'crypto' ? (portfolio.realizedProfitIdr || 0) - idx : idx;
}

export function bookView(portfolio, market) {
  ensureBooks(portfolio);
  const others = MARKETS.filter((m) => m !== market);
  return {
    market,
    positions: positionsOf(portfolio, market),
    get balanceIdr() { return portfolio.balanceIdr; },
    set balanceIdr(value) { portfolio.balanceIdr = value; },
    get initialBalanceIdr() { return portfolio.initialBalanceIdr; },
    get transactions() { return portfolio.transactions; },
    set transactions(value) { portfolio.transactions = value; },
    // The account total stays in portfolio.realizedProfitIdr; IDX also keeps its own.
    get realizedProfitIdr() { return realizedOf(portfolio, market); },
    set realizedProfitIdr(value) {
      const delta = value - realizedOf(portfolio, market);
      portfolio.realizedProfitIdr = (portfolio.realizedProfitIdr || 0) + delta;
      if (market !== 'crypto') portfolio.books[market].realizedProfitIdr = (portfolio.books[market].realizedProfitIdr || 0) + delta;
    },
    get otherInvestedIdr() { return others.reduce((s, m) => s + investedOf(positionsOf(portfolio, m)), 0); },
    get otherOpenRiskIdr() { return others.reduce((s, m) => s + openRiskOf(positionsOf(portfolio, m)), 0); }
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

// Account snapshot for the dashboard: equity marked to market, cash, and per
// market what is invested, its market value and P&L.
// prices: { crypto: { BTCUSDT: 123 }, idx: { BBCA: 9000 } }; fx: { crypto: usdIdrRate, idx: 1 }.
export function accountSnapshot(portfolio, prices, fx) {
  ensureBooks(portfolio);
  const markets = {};
  let valueIdr = 0;
  for (const market of MARKETS) {
    const list = [];
    let invested = 0;
    let value = 0;
    for (const [symbol, p] of Object.entries(positionsOf(portfolio, market))) {
      const price = prices[market]?.[symbol];
      const marketIdr = Number.isFinite(price) ? p.quantity * price * fx[market] : p.investedIdr || 0;
      invested += p.investedIdr || 0;
      value += marketIdr;
      list.push({
        ...p, symbol, market,
        currentPrice: Number.isFinite(price) ? price : null,
        marketValueIdr: round2(marketIdr),
        unrealizedProfitIdr: round2(marketIdr - (p.investedIdr || 0)),
        unrealizedProfitPct: p.investedIdr > 0 ? round2(((marketIdr - p.investedIdr) / p.investedIdr) * 100) : 0
      });
    }
    valueIdr += value;
    markets[market] = {
      investedIdr: round2(invested), marketValueIdr: round2(value), unrealizedProfitIdr: round2(value - invested),
      realizedProfitIdr: round2(realizedOf(portfolio, market)), openPositions: list.length, positions: list
    };
  }
  const equityIdr = round2(portfolio.balanceIdr + valueIdr);
  return {
    cashIdr: round2(portfolio.balanceIdr),
    initialBalanceIdr: portfolio.initialBalanceIdr,
    equityIdr,
    totalReturnPct: portfolio.initialBalanceIdr > 0 ? round2(((equityIdr - portfolio.initialBalanceIdr) / portfolio.initialBalanceIdr) * 100) : 0,
    realizedProfitIdr: round2(portfolio.realizedProfitIdr || 0),
    markets,
    updatedAt: portfolio.updatedAt || null
  };
}
