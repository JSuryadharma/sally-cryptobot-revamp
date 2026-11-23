// Minimal Binance Spot REST client for real orders: HMAC-SHA256 signed
// requests, market buys by quote amount (USDT), market sells by quantity
// rounded to the symbol's LOT_SIZE step. Works against the Spot testnet
// (https://testnet.binance.vision) and live (https://api.binance.com).
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/rest-api
import crypto from 'node:crypto';

export const BINANCE_BASE = { testnet: 'https://testnet.binance.vision', live: 'https://api.binance.com' };

export function createBinanceClient({ apiKey, apiSecret, baseUrl, fetchImpl = fetch, recvWindow = 5000, now = () => Date.now() }) {
  if (!apiKey || !apiSecret) throw new Error('Binance API key/secret missing');
  const filtersCache = new Map();

  async function request(method, path, params = {}, { signed = false } = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    if (signed) {
      query.set('recvWindow', String(recvWindow));
      query.set('timestamp', String(now()));
      query.set('signature', crypto.createHmac('sha256', apiSecret).update(query.toString()).digest('hex'));
    }
    const url = `${baseUrl}${path}${query.toString() ? `?${query}` : ''}`;
    const res = await fetchImpl(url, { method, headers: { 'X-MBX-APIKEY': apiKey } });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text }; }
    if (!res.ok) {
      const error = new Error(`Binance ${res.status} ${body.code ?? ''} ${body.msg || ''}`.trim());
      error.status = res.status; error.code = body.code;
      throw error;
    }
    return body;
  }

  async function filters(symbol) {
    if (filtersCache.has(symbol)) return filtersCache.get(symbol);
    const info = await request('GET', '/api/v3/exchangeInfo', { symbol });
    const s = info.symbols?.[0];
    if (!s) throw new Error(`Unknown Binance symbol ${symbol}`);
    const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE') || {};
    const mkt = s.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') || {};
    const notional = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {};
    const out = {
      status: s.status,
      stepSize: Number(mkt.stepSize > 0 ? mkt.stepSize : lot.stepSize) || 0,
      minQty: Number(mkt.minQty > 0 ? mkt.minQty : lot.minQty) || 0,
      minNotional: Number(notional.minNotional) || 0,
      quotePrecision: s.quoteAssetPrecision ?? s.quotePrecision ?? 8
    };
    filtersCache.set(symbol, out);
    return out;
  }

  return {
    baseUrl,
    ping: () => request('GET', '/api/v3/ping'),
    account: () => request('GET', '/api/v3/account', { omitZeroBalances: true }, { signed: true }),
    async freeBalance(asset) {
      const acc = await request('GET', '/api/v3/account', { omitZeroBalances: true }, { signed: true });
      const b = (acc.balances || []).find((x) => x.asset === asset);
      return { free: Number(b?.free || 0), canTrade: acc.canTrade !== false, permissions: acc.permissions || [] };
    },
    filters,
    async marketBuyQuote(symbol, quoteQty, clientOrderId, { test = false } = {}) {
      const f = await filters(symbol);
      if (f.status && f.status !== 'TRADING') throw new Error(`${symbol} is not trading (${f.status})`);
      if (quoteQty < f.minNotional) throw new Error(`${symbol}: ${quoteQty.toFixed(2)} USDT is below Binance's minimum ${f.minNotional}`);
      const params = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty.toFixed(Math.min(f.quotePrecision, 8)).replace(/\.?0+$/, ''), newClientOrderId: clientOrderId, newOrderRespType: 'FULL' };
      return request('POST', test ? '/api/v3/order/test' : '/api/v3/order', params, { signed: true });
    },
    async marketSell(symbol, quantity, clientOrderId, { test = false } = {}) {
      const f = await filters(symbol);
      const qty = roundDown(quantity, f.stepSize);
      if (!(qty > 0) || qty < f.minQty) throw new Error(`${symbol}: quantity ${quantity} is below the minimum ${f.minQty}`);
      const params = { symbol, side: 'SELL', type: 'MARKET', quantity: fmtStep(qty, f.stepSize), newClientOrderId: clientOrderId, newOrderRespType: 'FULL' };
      return request('POST', test ? '/api/v3/order/test' : '/api/v3/order', params, { signed: true });
    },
    getOrder: (symbol, origClientOrderId) => request('GET', '/api/v3/order', { symbol, origClientOrderId }, { signed: true })
  };
}

export function roundDown(value, step) {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const n = Math.floor(value / step + 1e-9) * step;
  return Number(n.toFixed(decimals));
}
function fmtStep(qty, step) {
  const decimals = step > 0 ? Math.max(0, Math.round(-Math.log10(step))) : 8;
  return qty.toFixed(decimals);
}

// Average fill price and filled quantities from an order response.
export function fillSummary(order) {
  const qty = Number(order.executedQty || 0);
  const quote = Number(order.cummulativeQuoteQty || 0);
  const fee = (order.fills || []).reduce((s, f) => s + Number(f.commission || 0) * (f.commissionAsset === order.symbol?.replace(/USDT$/, '') ? 1 : 0), 0);
  return { qty, quote, avgPrice: qty > 0 ? quote / qty : null, baseFee: fee, status: order.status, orderId: order.orderId };
}
