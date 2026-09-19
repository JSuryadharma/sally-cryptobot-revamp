// UPDATE: no longer wired to Vercel Cron - vercel.json's "crons" entry
// was removed in favor of .github/workflows/trading-loop.yml, a GitHub
// Actions schedule that calls POST /api/coins/refresh-all (server.js)
// every ~5 minutes instead of once/day (the Vercel Hobby cron cap this
// endpoint used to run into). This route and handler are left in place
// and still work if hit directly or re-wired to cron later - just nothing
// currently schedules it automatically.
//
// Vercel Cron target - replaces the setInterval(tick, ...) loop in
// src/server.js, which never actually runs on Vercel: serverless functions
// are stateless per-invocation, so a timer set up inside one request has no
// persistent process to keep firing on afterwards. This route does the same
// work (refreshAll across the watchlist) but is invoked externally on a
// schedule (see vercel.json's "crons" entry) and writes the combined result
// to persistent storage (Postgres on Vercel, a local file otherwise - see
// src/storage.js) instead of an in-memory Map, so it's visible to whichever
// serverless instance handles the next /api/coins request.
//
// NOTE on cron frequency: Vercel's Hobby/free plan doesn't just throttle a
// too-frequent schedule down to once a day - it REJECTS the deployment
// outright ("Hobby accounts are limited to daily cron jobs," confirmed
// directly against a real deployment) if vercel.json's schedule would fire
// more than once/day, so this is "0 0 * * *" (once daily, imprecise timing -
// Vercel doesn't guarantee the exact minute) rather than the far more useful
// */5 * * * * this was originally set to. Upgrading to Pro lifts this cap if
// tighter cron freshness matters more than the cost.
//
// This is exactly why src/server.js also exposes POST /api/coins/refresh-all,
// a manual trigger using the same refreshWatchlistAndCache() this file
// calls: on Hobby, cron alone cannot keep data fresh through the day, so the
// dashboard's refresh button is the real mechanism, not a nice-to-have.
//
// Uses raw res.writeHead/res.end (not res.status()/res.json()) to match this
// project's existing low-level style in src/server.js's sendJson(), and to
// work regardless of which Vercel Node.js runtime helper methods are present.
import { forceRefreshNow } from '../../src/refreshWatchlist.js';

export default async function handler(req, res) {
  try {
    const { cache, errors } = await forceRefreshNow();
    const body = JSON.stringify({ ok: true, refreshedCount: Object.keys(cache).length, errors, at: new Date().toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (error) {
    console.error('[cron/refresh] failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}
