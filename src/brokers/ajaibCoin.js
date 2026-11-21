// Ajaib Coin Exchange REST client (Ajaib Kripto). Built from a third-party
// OpenAPI transcription of Ajaib's GitBook docs (ajaib.gitbook.io/coin-exchange,
// via apis.io, Nov 2026) - verify on the testnet before going live.
//   Base: https://api.ajaib.tech (testnet), https://api.ajaib.co.id (live)
//   Paths under /coin/internal/v1; symbols BASE_QUOTE (BTC_IDR, BTC_USDT).
//   Auth: X-API-KEY, X-TIMESTAMP (ms), X-SIGNATURE = ECDSA-SHA256 over
//   timestamp + METHOD + requestPath + queryString + compactJsonBody with the
//   private key whose public key you emailed to Ajaib (tech@ajaib.co.id).
//   Orders are LIMIT / LIMIT_MAKER only, so a "market" order here is a
//   marketable limit (last price +/- a buffer), polled until filled, and the
//   unfilled rest cancelled.
import crypto from 'node:crypto';

export const AJAIB_BASE = { testnet: 'https://api.ajaib.tech', live: 'https://api.ajaib.co.id' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DONE = new Set(['FILLED', 'CANCELLED', 'PARTIAL_CANCELLED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'PARTIALLY_EXPIRED_IN_MATCH']);

export function createAjaibClient({
  apiKey, privateKeyPem, baseUrl, prefix = '/coin/internal/v1', fetchImpl = fetch, now = () => Date.now(),
  sigEncoding = 'base64', dsaEncoding = 'der', pollMs = 1500, pollTries = 10, slippagePct = 0.5, wait = sleep
}) {
  if (!apiKey || !privateKeyPem) throw new Error('Ajaib API key / private key missing');
  const key = crypto.createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
  let infoCache = null;

  async function request(method, path, { query = null, body = null, signed = true } = {}) {
    const requestPath = `${prefix}${path}`.toLowerCase();
    const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('&') : '';
    const json = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (signed) {
      const ts = String(now());
      const payload = `${ts}${method.toUpperCase()}${requestPath}${qs}${json}`;
      const sig = crypto.sign('sha256', Buffer.from(payload), { key, dsaEncoding });
      Object.assign(headers, { 'X-API-KEY': apiKey, 'X-TIMESTAMP': ts, 'X-SIGNATURE': sig.toString(sigEncoding) });
    }
    const res = await fetchImpl(`${baseUrl}${requestPath}${qs ? `?${qs}` : ''}`, { method, headers, body: json || undefined });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok || (data && data.error && !Array.isArray(data))) {
      const error = new Error(`Ajaib ${res.status} ${data?.error || ''}`.trim());
      error.status = res.status; error.code = data?.error;
      throw error;
    }
    return data;
  }

  async function pair(symbol) {
    if (!infoCache) infoCache = await request('GET', '/public/exchange-info', { signed: false });
    const p = (Array.isArray(infoCache) ? infoCache : infoCache.symbols || []).find((x) => x.symbol === symbol);
    if (!p) throw new Error(`Ajaib has no pair ${symbol}`);
    return { precision: Number(p.base_precision ?? 8), tick: Number(p.quote_tick || 0) };
  }

  async function waitFill(symbol, orderId) {
    let order = null;
    for (let k = 0; k < pollTries; k += 1) {
      await wait(pollMs);
      order = await request('GET', '/order', { query: { order_id: orderId, symbol } });
      if (DONE.has(order.status)) break;
    }
    if (order && !DONE.has(order.status)) {
      try { await request('DELETE', '/order', { query: { order_id: orderId, symbol } }); } catch { /* may have filled meanwhile */ }
      await wait(pollMs);
      order = await request('GET', '/order', { query: { order_id: orderId, symbol } });
    }
    const qty = Number(order?.executed_quantity || 0);
    const avg = Number(order?.avg_price || 0);
    return { qty, avgPrice: qty > 0 ? avg : null, quote: qty * avg, status: order?.status, orderId };
  }

  async function limitOrder(symbol, side, { quote, quantity }) {
    const { precision, tick } = await pair(symbol);
    const last = Number((await request('GET', '/price', { query: { symbol } })).price);
    if (!(last > 0)) throw new Error(`No Ajaib price for ${symbol}`);
    const raw = side === 'BUY' ? last * (1 + slippagePct / 100) : last * (1 - slippagePct / 100);
    const price = roundTick(raw, tick, side === 'BUY' ? 'up' : 'down');
    const qty = floorDp(quantity ?? quote / price, precision);
    if (!(qty > 0)) throw new Error(`${symbol}: order too small`);
    const placed = await request('POST', '/order', { body: { side, symbol, type: 'LIMIT', price, quantity: qty } });
    return waitFill(symbol, placed.order_id);
  }

  return {
    baseUrl,
    serverTime: () => request('GET', '/public/time', { signed: false }),
    exchangeInfo: () => request('GET', '/public/exchange-info', { signed: false }),
    portfolio: () => request('GET', '/portfolio'),
    async free(asset) {
      const rows = await request('GET', '/portfolio');
      return Number((rows || []).find((r) => r.asset === asset)?.free || 0);
    },
    pair,
    buyQuote: (symbol, quote) => limitOrder(symbol, 'BUY', { quote }),
    sell: (symbol, quantity) => limitOrder(symbol, 'SELL', { quantity })
  };
}

export function floorDp(v, dp) { const f = 10 ** dp; return Math.floor(v * f + 1e-9) / f; }
export function roundTick(v, tick, dir) {
  if (!(tick > 0)) return v;
  const dp = Math.max(0, Math.round(-Math.log10(tick)));
  const n = dir === 'up' ? Math.ceil(v / tick - 1e-9) * tick : Math.floor(v / tick + 1e-9) * tick;
  return Number(n.toFixed(dp));
}
