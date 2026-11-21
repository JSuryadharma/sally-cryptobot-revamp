import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBinanceClient, roundDown } from '../src/brokers/binance.js';
import { reconcileBrokers, emptyBrokerState } from '../src/brokers/execution.js';

// Fake Binance Spot REST: checks signatures and fills market orders at fixed prices.
function fakeBinance({ secret = 's3cret', prices = { BTCUSDT: 50000, ETHUSDT: 2500 }, usdt = 1000 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams);
    calls.push({ method: opts.method, path: u.pathname, params });
    if (params.signature) {
      const q = new URLSearchParams(u.searchParams); q.delete('signature');
      const expect = crypto.createHmac('sha256', secret).update(q.toString()).digest('hex');
      if (expect !== params.signature) return new Response(JSON.stringify({ code: -1022, msg: 'Signature invalid' }), { status: 400 });
    }
    if (u.pathname === '/api/v3/exchangeInfo') return Response.json({ symbols: [{ symbol: params.symbol, status: 'TRADING', quoteAssetPrecision: 8, filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] });
    if (u.pathname === '/api/v3/account') return Response.json({ canTrade: true, balances: [{ asset: 'USDT', free: String(usdt) }] });
    if (u.pathname === '/api/v3/order') {
      const px = prices[params.symbol];
      const qty = params.side === 'BUY' ? Math.floor(Number(params.quoteOrderQty) / px * 1e5) / 1e5 : Number(params.quantity);
      if (params.side === 'BUY') usdt -= qty * px; else usdt += qty * px;
      return Response.json({ symbol: params.symbol, orderId: calls.length, status: 'FILLED', executedQty: String(qty), cummulativeQuoteQty: String(qty * px), fills: [] });
    }
    return Response.json({});
  };
  return { fetchImpl, calls, get usdt() { return usdt; } };
}

const env = { BROKER_CRYPTO: 'binance-testnet', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's3cret', BROKER_MAX_ORDER_USDT: '100' };

function harness(fake) {
  let stored = emptyBrokerState();
  const client = createBinanceClient({ apiKey: 'k', apiSecret: 's3cret', baseUrl: 'https://testnet.binance.vision', fetchImpl: fake.fetchImpl });
  const notes = [];
  return {
    notes,
    get state() { return stored; },
    run: (portfolio, settings, nowMs) => reconcileBrokers({ portfolio, settings, usdIdrRate: 16000, env, client, nowMs, notifications: { notify: async (n) => notes.push(n) }, loadState: async () => structuredClone(stored), saveState: async (s) => { stored = s; } })
  };
}

const T0 = Date.parse('2026-11-21T10:00:00Z');
const pos = (over = {}) => ({ symbol: 'BTCUSDT', tradeId: 'trade_1', setup: 'breakout', openedAt: new Date(T0 + 60_000).toISOString(), investedUsdt: 400, investedIdr: 6_400_000, entryPrice: 50000, stopPrice: 47000, quantity: 0.008, ...over });

test('copies a new robot buy (capped), then sells exactly what was bought when the paper trade closes', async () => {
  const fake = fakeBinance();
  const h = harness(fake);
  const settings = { liveTrading: { cryptoEnabled: true, cryptoEnabledAt: new Date(T0).toISOString() } };
  const portfolio = { positions: { BTCUSDT: pos() }, books: {} };
  const r1 = await h.run(portfolio, settings, T0 + 120_000);
  assert.deepEqual(r1.actions.map((a) => a.kind), ['buy']);
  const buy = fake.calls.find((c) => c.path === '/api/v3/order');
  assert.equal(buy.params.quoteOrderQty, '100'); // capped by BROKER_MAX_ORDER_USDT
  assert.equal(h.state.crypto.trade_1.qty, 0.002);
  // Same pass again: nothing new.
  assert.equal((await h.run(portfolio, settings, T0 + 180_000)).actions.length, 0);
  // Paper trade closed -> sell; works even after the switch is turned off.
  const r3 = await h.run({ positions: {}, books: {} }, { liveTrading: { cryptoEnabled: false } }, T0 + 240_000);
  assert.deepEqual(r3.actions.map((a) => a.kind), ['sell']);
  const sell = fake.calls.filter((c) => c.path === '/api/v3/order').at(-1);
  assert.equal(sell.params.quantity, '0.00200');
  assert.deepEqual(h.state.crypto, {});
});

test('never copies paper positions opened before the switch, manual buys, or stale buys', async () => {
  const fake = fakeBinance();
  const h = harness(fake);
  const settings = { liveTrading: { cryptoEnabled: true, cryptoEnabledAt: new Date(T0).toISOString() } };
  const portfolio = { positions: {
    BTCUSDT: pos({ openedAt: new Date(T0 - 60_000).toISOString() }),
    ETHUSDT: pos({ symbol: 'ETHUSDT', tradeId: 'trade_2', setup: 'manual' })
  }, books: {} };
  assert.equal((await h.run(portfolio, settings, T0 + 120_000)).actions.length, 0);
  const late = { positions: { BTCUSDT: pos({ tradeId: 'trade_3' }) }, books: {} };
  assert.equal((await h.run(late, settings, T0 + 3 * 3600_000)).actions.length, 0);
  assert.equal(fake.calls.filter((c) => c.path === '/api/v3/order').length, 0);
});

test('paper mode or missing keys never calls Binance', async () => {
  let called = false;
  const r = await reconcileBrokers({ portfolio: { positions: { BTCUSDT: pos() }, books: {} }, settings: { liveTrading: { cryptoEnabled: true } }, usdIdrRate: 16000, env: { BROKER_CRYPTO: 'paper' }, client: { marketBuyQuote: () => { called = true; } }, loadState: async () => emptyBrokerState(), saveState: async () => {} });
  assert.equal(r.actions.length, 0);
  assert.equal(called, false);
});

test('IDX: Ajaib order tickets for new buys and closed positions', async () => {
  const notes = [];
  let stored = emptyBrokerState();
  const run = (portfolio) => reconcileBrokers({ portfolio, settings: { liveTrading: { idxTickets: true, idxTicketsAt: new Date(T0).toISOString() } }, usdIdrRate: 16000, env: {}, nowMs: T0 + 60_000, notifications: { notify: async (n) => notes.push(n) }, loadState: async () => structuredClone(stored), saveState: async (s) => { stored = s; } });
  await run({ positions: {}, books: { idx: { positions: { 'BBCA.JK': { symbol: 'BBCA.JK', tradeId: 't9', quantity: 300, entryPrice: 9150, stopPrice: 8700, openedAt: new Date(T0 + 1000).toISOString() } } } } });
  assert.match(notes[0].message, /BELI BBCA 3 lot/);
  await run({ positions: {}, books: { idx: { positions: {} } } });
  assert.match(notes[1].message, /JUAL BBCA 3 lot/);
});

test('roundDown respects the lot step', () => {
  assert.equal(roundDown(0.0123456, 0.0001), 0.0123);
  assert.equal(roundDown(15.97, 1), 15);
});
