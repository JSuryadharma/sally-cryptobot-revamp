// Shared by api/cron/refresh.js (scheduled, once/day on Vercel Hobby - see
// its own comment for why that's nearly useless alone), server.js's POST
// /api/coins/refresh-all (manual, user-triggered), and server.js's GET
// /api/coins (automatic, inline - refreshes itself when the shared cache is
// older than STALE_AFTER_MS, so the dashboard stays fresh on any plan
// without depending on cron timing or a manual click at all). All three
// need the exact same "refresh every watchlist symbol, write the combined
// result to persistent storage" logic, so it lives in one place instead of
// three copies that could drift.
import { readSettings } from './settings.js';
import { refreshAll } from './robotEngine.js';
import { NotificationCenter } from './notifications.js';
import { readJson, writeJson } from './storage.js';

export const COINS_CACHE_KEY = 'coins-cache.json';
export const STALE_AFTER_MS = 2 * 60_000; // 2 minutes - matches loadSnapshot's own shortest per-symbol cache TTL (scalping), so this isn't fresher than the data underneath it can actually be

export async function refreshWatchlistAndCache(symbols, { force = false } = {}) {
  const watchlist = symbols || (await readSettings()).watchlist;
  const notifications = new NotificationCenter(); // no setBroadcast() - see api/cron/refresh.js's note on why
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

// Reads the shared cache and reports how stale it is, without triggering a
// refresh itself - callers decide what to do with that (server.js's GET
// /api/coins uses it to decide whether to refresh inline before responding).
export async function readCoinsCache() {
  const stored = await readJson(COINS_CACHE_KEY, null);
  if (!stored) return { coins: {}, updatedAt: null, ageMs: Infinity };
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
  return { coins: stored.coins || {}, updatedAt: stored.updatedAt, ageMs };
}

// De-dupes concurrent callers into one in-flight refresh - without this,
// several browser polls landing at once while the cache is stale would each
// kick off their own refreshAll(), which is wasteful and, worse, unsafe:
// refreshAll's own portfolio-mutating phase is already sequential *within*
// one call, but two *separate* concurrent calls could each open the same
// symbol's position from a stale read, racing on the shared portfolio
// balance exactly like robotEngine.js's own top comment warns about.
//
// This one guard now covers every entry point that can kick off a full
// watchlist pass - the inline staleness check below, the dashboard's
// automatic 30s refresh-all poll, the manual "Refresh All" button (both hit
// server.js's POST /api/coins/refresh-all), and api/cron/refresh.js -
// because with the browser now polling refresh-all on its own timer, the
// odds of two of these landing at the same moment are no longer a rare
// edge case.
let refreshInFlight = null;
function runRefresh(symbols, opts) {
  if (!refreshInFlight) {
    refreshInFlight = refreshWatchlistAndCache(symbols, opts).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function refreshIfStale(symbols) {
  const cached = await readCoinsCache();
  if (cached.ageMs < STALE_AFTER_MS) return cached;
  await runRefresh(symbols);
  return readCoinsCache();
}

// Always forces a real Binance re-fetch regardless of the shared cache's
// age - used by server.js's POST /api/coins/refresh-all (both the manual
// button and the new automatic 30s poll) and api/cron/refresh.js - but
// still joins an already-running refresh via runRefresh() above instead of
// starting a second, concurrent one.
export async function forceRefreshNow(symbols) {
  return runRefresh(symbols, { force: true });
}
