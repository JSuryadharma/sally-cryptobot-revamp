// The per-coin dashboard payloads written by each engine tick (src/engine/tick.js).
import { readJson, writeJson } from './storage.js';

export const COINS_CACHE_KEY = 'coins-cache.json';

export async function writeCoinsCache(coins) {
  await writeJson(COINS_CACHE_KEY, { updatedAt: new Date().toISOString(), coins });
}

export async function readCoinsCache() {
  const stored = await readJson(COINS_CACHE_KEY, null);
  if (!stored) return { coins: {}, updatedAt: null, ageMs: Infinity };
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
  return { coins: stored.coins || {}, updatedAt: stored.updatedAt, ageMs };
}
