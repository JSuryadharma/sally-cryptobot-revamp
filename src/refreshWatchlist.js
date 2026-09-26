// Runs one full watchlist pass and writes the combined result to the shared
// coins cache. Callers must hold the engine lease (see src/engine/tick.js) -
// this module no longer de-dupes concurrent callers itself, because an
// in-memory guard can't see other serverless instances.
import { readSettings } from './settings.js';
import { refreshAll } from './robotEngine.js';
import { NotificationCenter } from './notifications.js';
import { readJson, writeJson } from './storage.js';

export const COINS_CACHE_KEY = 'coins-cache.json';

export async function refreshWatchlistAndCache(symbols, { force = false } = {}) {
  const watchlist = symbols || (await readSettings()).watchlist;
  const notifications = new NotificationCenter();
  const results = await refreshAll(watchlist, { notifications, force });

  const coins = {};
  const errors = [];
  for (const result of results) {
    if (result && result.symbol && !result.error) coins[result.symbol] = result;
    else if (result?.error) errors.push({ symbol: result.symbol, error: result.error });
  }
  await writeJson(COINS_CACHE_KEY, { updatedAt: new Date().toISOString(), coins });
  return { cache: coins, errors };
}

export async function writeCoinCacheEntry(symbol, result) {
  const stored = await readJson(COINS_CACHE_KEY, { updatedAt: new Date().toISOString(), coins: {} });
  stored.coins = { ...(stored.coins || {}), [symbol]: result };
  await writeJson(COINS_CACHE_KEY, stored);
}

export async function readCoinsCache() {
  const stored = await readJson(COINS_CACHE_KEY, null);
  if (!stored) return { coins: {}, updatedAt: null, ageMs: Infinity };
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
  return { coins: stored.coins || {}, updatedAt: stored.updatedAt, ageMs };
}
