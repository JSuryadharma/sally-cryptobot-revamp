// Real-money execution (Joe, 2026-11-21). The paper engine stays the brain;
// this layer copies its decisions to a real account by reconciling, once per
// engine pass, the robot's open paper positions with what was bought for real:
//   - a new paper position (opened after real trading was switched on, and
//     less than MAX_ENTRY_DELAY_MIN old) -> market buy on the broker;
//   - a real position whose paper position is gone (stop, target, time stop,
//     manual sell, reset) -> market sell of exactly what was bought.
// Reconciling instead of replaying transactions means nothing is bought twice
// after a crash and every exit path is covered.
//
// Crypto: Binance Spot (market orders; Joe 2026-11-21). Ajaib Coin Exchange is
// kept as an option but only accepts limit orders.
// IDX: Ajaib has no public stock trading API, so the robot sends an order
// ticket (notification + Telegram) for you to place in the Ajaib app.
//
// Real orders need BOTH the server env (BROKER_CRYPTO, keys) and the Settings
// switch (settings.liveTrading.cryptoEnabled). The switch can only arm what
// the server env allows; the env cannot be changed from the web page.
import { readJson, writeJson } from '../storage.js';
import { bookView } from '../account.js';
import { createBinanceClient, BINANCE_BASE, fillSummary } from './binance.js';
import { createAjaibClient, AJAIB_BASE } from './ajaibCoin.js';

export const BROKER_STATE_KEY = 'broker-state.json';
const MAX_LOG = 200;

export function brokerEnv(env = process.env) {
  // ajaib-testnet | ajaib-live | binance-testnet | binance-live | paper (default)
  const raw = (env.BROKER_CRYPTO || 'paper').toLowerCase();
  const m = raw.match(/^(ajaib|binance)-(testnet|live)$/);
  const venue = m ? m[1] : null;
  const network = m ? m[2] : null;
  const quote = venue === 'ajaib' ? (env.AJAIB_QUOTE || 'IDR').toUpperCase() : 'USDT';
  const hasKeys = venue === 'ajaib' ? Boolean(env.AJAIB_API_KEY && env.AJAIB_PRIVATE_KEY)
    : venue === 'binance' ? Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET) : false;
  const defaultCap = quote === 'IDR' ? 1_000_000 : 50;
  return {
    cryptoMode: m ? raw : 'paper',
    venue, network, quote, hasKeys,
    baseUrl: venue === 'ajaib' ? (env.AJAIB_BASE_URL || AJAIB_BASE[network]) : venue === 'binance' ? (env.BINANCE_BASE_URL || BINANCE_BASE[network]) : null,
    maxOrder: Number(env.BROKER_MAX_ORDER || (venue === 'binance' ? env.BROKER_MAX_ORDER_USDT : null) || defaultCap),
    scale: Number(env.BROKER_SCALE || 1),
    maxEntryDelayMin: Number(env.BROKER_MAX_ENTRY_DELAY_MIN || 30),
    idxMode: (env.BROKER_IDX || 'ajaib-manual').toLowerCase() // ajaib-manual | off
  };
}

// One interface for both venues: free(quote), buy(symbol, quoteAmount, id), sell(symbol, qty, id).
export function createVenue(cfg, env = process.env, client = null) {
  const pairOf = (symbol) => (cfg.venue === 'ajaib' ? `${symbol.replace(/USDT$/, '')}_${cfg.quote}` : symbol);
  if (cfg.venue === 'ajaib') {
    const api = client || createAjaibClient({
      apiKey: env.AJAIB_API_KEY, privateKeyPem: env.AJAIB_PRIVATE_KEY, baseUrl: cfg.baseUrl,
      prefix: env.AJAIB_PATH_PREFIX || '/coin/internal/v1', sigEncoding: env.AJAIB_SIG_ENCODING || 'base64', dsaEncoding: env.AJAIB_DSA_ENCODING || 'der'
    });
    return {
      pairOf,
      free: () => api.free(cfg.quote),
      buy: (symbol, amount) => api.buyQuote(pairOf(symbol), amount),
      sell: (symbol, qty) => api.sell(pairOf(symbol), qty),
      async test() {
        const time = await api.serverTime();
        const free = await api.free(cfg.quote);
        await api.pair(pairOf('BTCUSDT'));
        return { free, note: `server time ${new Date(Number(time.timestamp)).toISOString()}, pair ${pairOf('BTCUSDT')} found` };
      }
    };
  }
  const api = client || createBinanceClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, baseUrl: cfg.baseUrl });
  return {
    pairOf,
    free: async () => (await api.freeBalance('USDT')).free,
    buy: async (symbol, amount, id) => fillSummary(await api.marketBuyQuote(symbol, amount, id)),
    sell: async (symbol, qty, id) => fillSummary(await api.marketSell(symbol, qty, id)),
    async test() {
      const { free } = await api.freeBalance('USDT');
      await api.marketBuyQuote('BTCUSDT', Math.max(10, Math.min(cfg.maxOrder, 20)), clientId('tx', `test${Date.now()}`), { test: true });
      return { free, note: 'test order accepted (nothing was bought)' };
    }
  };
}

export function emptyBrokerState() {
  return { version: 1, crypto: {}, idxTickets: {}, failed: {}, log: [], armedAt: null };
}

function pushLog(state, entry) {
  state.log = [{ at: new Date().toISOString(), ...entry }, ...(state.log || [])].slice(0, MAX_LOG);
}

const clientId = (prefix, tradeId) => `${prefix}${String(tradeId).replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 36);

// One reconcile pass. Returns { actions, state }; never throws for a broker error.
export async function reconcileBrokers({ portfolio, settings, usdIdrRate, notifications, env = process.env, client = null, nowMs = Date.now(), loadState = () => readJson(BROKER_STATE_KEY, emptyBrokerState()), saveState = (s) => writeJson(BROKER_STATE_KEY, s) }) {
  const cfg = brokerEnv(env);
  const live = settings.liveTrading || {};
  const actions = [];
  // Nothing configured: no storage round trip.
  if ((cfg.cryptoMode === 'paper' || !cfg.hasKeys) && !(cfg.idxMode === 'ajaib-manual' && live.idxTickets === true)) return { actions, state: null };
  const state = { ...emptyBrokerState(), ...(await loadState()) };
  const notify = async (title, message, level = 'info') => { try { await notifications?.notify({ title, message, level, category: 'trade' }); } catch { /* notification failures never block trading */ } };

  // ---- crypto: Ajaib Coin or Binance ----
  // Exits keep running while the server is configured, even with the switch
  // off, so real coins are never left without the robot's stop/target.
  const canTrade = cfg.cryptoMode !== 'paper' && cfg.hasKeys;
  const buysOn = canTrade && live.cryptoEnabled === true;
  state.armedAt = buysOn ? (live.cryptoEnabledAt || state.armedAt || new Date(nowMs).toISOString()) : null;
  const label = `REAL ${cfg.venue} ${cfg.network}`;
  if (canTrade && (buysOn || Object.keys(state.crypto).length)) {
    let venue = null;
    try { venue = createVenue(cfg, env, client); } catch (error) { pushLog(state, { market: 'crypto', kind: 'error', message: error.message }); }
    const paper = portfolio.positions || {};
    const paperTradeIds = new Set(Object.values(paper).map((p) => p.tradeId));
    // Exits first: frees cash for the buys.
    for (const [tradeId, pos] of Object.entries(state.crypto)) {
      if (paperTradeIds.has(tradeId) || !venue) continue;
      try {
        const fill = await venue.sell(pos.symbol, pos.qty, clientId('sx', tradeId));
        const soldShare = pos.qty > 0 ? Math.min(1, fill.qty / pos.qty) : 1;
        const cost = pos.quoteSpent * soldShare;
        const pnl = fill.quote - cost;
        pos.qty = Math.max(0, pos.qty - fill.qty);
        pos.quoteSpent -= cost;
        pushLog(state, { market: 'crypto', kind: 'sell', symbol: pos.symbol, tradeId, qty: fill.qty, amount: fill.quote, quote: cfg.quote, avgPrice: fill.avgPrice, pnl, venue: cfg.venue, network: cfg.network });
        actions.push({ kind: 'sell', symbol: pos.symbol, amount: fill.quote });
        if (pos.qty <= pos.dust) delete state.crypto[tradeId];
        await notify(`${label}: sold ${pos.symbol}`, `${fill.qty} at ~${fill.avgPrice?.toPrecision(6)} = ${fill.quote.toFixed(2)} ${cfg.quote} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ${cfg.quote})${state.crypto[tradeId] ? `; ${pos.qty} left, retrying next pass` : ''}.`);
      } catch (error) {
        pos.sellErrors = (pos.sellErrors || 0) + 1;
        pushLog(state, { market: 'crypto', kind: 'sell-failed', symbol: pos.symbol, tradeId, message: error.message });
        if (pos.sellErrors === 1 || pos.sellErrors % 12 === 0) await notify(`${label}: SELL FAILED ${pos.symbol}`, `${error.message}. The robot retries every pass; check the account and sell by hand if needed.`, 'error');
      }
    }
    // Entries.
    for (const p of Object.values(paper)) {
      const tradeId = p.tradeId;
      if (!buysOn || !venue || state.crypto[tradeId] || state.failed[tradeId] || p.setup === 'manual') continue;
      const openedMs = Date.parse(p.openedAt);
      if (!(openedMs >= Date.parse(state.armedAt))) continue; // opened before real trading was armed
      if (nowMs - openedMs > cfg.maxEntryDelayMin * 60_000) { state.failed[tradeId] = 'too-late'; pushLog(state, { market: 'crypto', kind: 'skip', symbol: p.symbol, tradeId, message: `paper buy is older than ${cfg.maxEntryDelayMin} min` }); continue; }
      try {
        const paperAmount = cfg.quote === 'IDR' ? p.investedIdr : (p.investedUsdt ?? p.investedIdr / usdIdrRate);
        const free = await venue.free();
        const amount = Math.min(paperAmount * cfg.scale, cfg.maxOrder, free * 0.98);
        const fill = await venue.buy(p.symbol, amount, clientId('bx', tradeId));
        if (!(fill.qty > 0)) throw new Error(`order not filled (${fill.status || 'no fill'})`);
        state.crypto[tradeId] = { symbol: p.symbol, qty: Math.max(0, fill.qty - (fill.baseFee || 0)), dust: fill.qty * 0.001, quoteSpent: fill.quote, avgPrice: fill.avgPrice, orderId: fill.orderId, openedAt: new Date(nowMs).toISOString(), paperEntry: p.entryPrice, paperStop: p.stopPrice };
        pushLog(state, { market: 'crypto', kind: 'buy', symbol: p.symbol, tradeId, qty: fill.qty, amount: fill.quote, quote: cfg.quote, avgPrice: fill.avgPrice, venue: cfg.venue, network: cfg.network });
        actions.push({ kind: 'buy', symbol: p.symbol, amount: fill.quote });
        await notify(`${label}: bought ${p.symbol}`, `${fill.qty} at ~${fill.avgPrice?.toPrecision(6)} for ${fill.quote.toFixed(2)} ${cfg.quote}. Robot stop ${p.stopPrice}; the robot sells when its stop or target hits.`);
      } catch (error) {
        state.failed[tradeId] = error.message;
        pushLog(state, { market: 'crypto', kind: 'buy-failed', symbol: p.symbol, tradeId, message: error.message });
        await notify(`${label}: buy skipped ${p.symbol}`, error.message, 'warning');
      }
    }
    // Forget failure marks of closed paper trades.
    for (const id of Object.keys(state.failed)) if (!paperTradeIds.has(id)) delete state.failed[id];
  }

  // ---- IDX: Ajaib order tickets ----
  if (cfg.idxMode === 'ajaib-manual' && live.idxTickets === true) {
    const idxPositions = bookView(portfolio, 'idx').positions || {};
    const open = new Set(Object.values(idxPositions).map((p) => p.tradeId));
    const since = Date.parse(live.idxTicketsAt || 0);
    for (const p of Object.values(idxPositions)) {
      if (state.idxTickets[p.tradeId] || !(Date.parse(p.openedAt) >= since)) continue;
      const lots = Math.floor(p.quantity / 100);
      state.idxTickets[p.tradeId] = { symbol: p.symbol, lots, entry: p.entryPrice, stop: p.stopPrice, at: new Date(nowMs).toISOString() };
      const ticket = `BELI ${p.symbol.replace('.JK', '')} ${lots} lot, harga sekitar Rp ${Math.round(p.entryPrice).toLocaleString('id-ID')}. Stop Rp ${Math.round(p.stopPrice).toLocaleString('id-ID')}${p.targetPrice ? `, target Rp ${Math.round(p.targetPrice).toLocaleString('id-ID')}` : ''}.`;
      pushLog(state, { market: 'idx', kind: 'ticket-buy', symbol: p.symbol, tradeId: p.tradeId, lots, price: p.entryPrice });
      actions.push({ kind: 'ticket-buy', symbol: p.symbol });
      await notify('Order Ajaib: BELI', `${ticket} Pasang di aplikasi Ajaib.`, 'warning');
    }
    for (const [tradeId, t] of Object.entries(state.idxTickets)) {
      if (open.has(tradeId)) continue;
      delete state.idxTickets[tradeId];
      pushLog(state, { market: 'idx', kind: 'ticket-sell', symbol: t.symbol, tradeId, lots: t.lots });
      actions.push({ kind: 'ticket-sell', symbol: t.symbol });
      await notify('Order Ajaib: JUAL', `JUAL ${t.symbol.replace('.JK', '')} ${t.lots} lot di harga pasar (robot sudah menutup posisi ini). Pasang di aplikasi Ajaib.`, 'warning');
    }
  }

  await saveState(state);
  return { actions, state };
}

// Status for the Settings card (no secrets).
export async function brokerStatus({ settings, env = process.env, client = null }) {
  const cfg = brokerEnv(env);
  const state = { ...emptyBrokerState(), ...(await readJson(BROKER_STATE_KEY, emptyBrokerState())) };
  const live = settings.liveTrading || {};
  const out = {
    crypto: { mode: cfg.cryptoMode, venue: cfg.venue, network: cfg.network, quote: cfg.quote, hasKeys: cfg.hasKeys, enabled: live.cryptoEnabled === true, armed: cfg.cryptoMode !== 'paper' && cfg.hasKeys && live.cryptoEnabled === true, armedSince: live.cryptoEnabledAt || null, maxOrder: cfg.maxOrder, scale: cfg.scale, openPositions: Object.values(state.crypto).map(({ symbol, qty, quoteSpent, avgPrice, openedAt }) => ({ symbol, qty, quoteSpent, avgPrice, openedAt })) },
    idx: { mode: cfg.idxMode, tickets: live.idxTickets === true, openTickets: Object.values(state.idxTickets) },
    log: state.log.slice(0, 20)
  };
  return out;
}

// Connection test: reads the balance (Binance also validates a test order,
// which places nothing). Ajaib has no test-order endpoint, so nothing is sent.
export async function testBroker({ env = process.env, client = null } = {}) {
  const cfg = brokerEnv(env);
  if (cfg.cryptoMode === 'paper') return { ok: false, message: 'BROKER_CRYPTO is "paper" on the server. Set it to binance-testnet (or binance-live).' };
  if (!cfg.hasKeys) return { ok: false, message: cfg.venue === 'ajaib' ? 'AJAIB_API_KEY / AJAIB_PRIVATE_KEY are not set on the server.' : 'BINANCE_API_KEY / BINANCE_API_SECRET are not set on the server.' };
  try {
    const r = await createVenue(cfg, env, client).test();
    return { ok: true, venue: cfg.venue, network: cfg.network, free: r.free, message: `Connected to ${cfg.venue} ${cfg.network}. Free ${cfg.quote} ${Number(r.free).toLocaleString('en-US', { maximumFractionDigits: 2 })}; ${r.note}.` };
  } catch (error) {
    return { ok: false, venue: cfg.venue, network: cfg.network, message: error.message };
  }
}
