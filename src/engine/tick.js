import { randomUUID } from 'node:crypto';
import { readJson, writeJson, tryAcquireLease, releaseLease } from '../storage.js';
import { refreshWatchlistAndCache, readCoinsCache } from '../refreshWatchlist.js';
import { getStrategyState } from '../strategyState.js';
import { checkBearer } from '../auth.js';

const LEASE_NAME = 'engine';
const LEASE_TTL_MS = 120_000;
const TICK_LOG_KEY = 'engine-ticks.json';
const TICK_LOG_MAX = 300;
const STALE_AFTER_MS = 20 * 60_000;
export const MIN_TICK_GAP_MS = 60_000;

export class LeaseBusyError extends Error {
  constructor() { super('Engine is busy - another tick is running.'); this.code = 'LEASE_BUSY'; }
}

// Every portfolio mutation (scheduled tick, manual trade) runs under this one
// lease, so two serverless instances can never read-modify-write the portfolio
// at the same time.
export async function withEngineLease(fn) {
  const owner = randomUUID();
  if (!(await tryAcquireLease(LEASE_NAME, owner, LEASE_TTL_MS))) throw new LeaseBusyError();
  try {
    return await fn();
  } finally {
    await releaseLease(LEASE_NAME, owner).catch((error) => console.warn('[engine] lease release failed:', error.message));
  }
}

function summarizeResults(coins) {
  const signals = [];
  const fills = [];
  for (const coin of Object.values(coins)) {
    const decision = coin.entryOrExit || {};
    if (decision.action === 'BUY' || decision.action === 'SELL') {
      signals.push({
        symbol: coin.symbol, mode: coin.activeMode, action: decision.action,
        confidencePct: decision.confidencePct, executed: Boolean(decision.executed),
        reason: String(decision.reason || '').slice(0, 200)
      });
    }
    if (coin.transaction) {
      const tx = coin.transaction;
      fills.push({ symbol: tx.symbol, type: tx.type, price: tx.price, realizedProfitIdr: tx.realizedProfitIdr ?? null });
    }
  }
  return { signals, fills };
}

async function appendTickLog(entry) {
  const log = await readJson(TICK_LOG_KEY, []);
  log.unshift(entry);
  await writeJson(TICK_LOG_KEY, log.slice(0, TICK_LOG_MAX));
}

export async function readTickLog() {
  return readJson(TICK_LOG_KEY, []);
}

export async function runTick({ reason = 'scheduler' } = {}) {
  const startedAt = Date.now();
  let entry;
  try {
    entry = await withEngineLease(async () => {
      const { cache, errors } = await refreshWatchlistAndCache(undefined, { force: true });
      return {
        startedAt: new Date(startedAt).toISOString(), reason,
        durationMs: Date.now() - startedAt,
        symbolsOk: Object.keys(cache).length,
        symbolsFailed: errors,
        ...summarizeResults(cache)
      };
    });
  } catch (error) {
    if (error.code === 'LEASE_BUSY') return { skipped: 'locked' };
    entry = { startedAt: new Date(startedAt).toISOString(), reason, durationMs: Date.now() - startedAt, error: error.message };
    await appendTickLog(entry).catch(() => {});
    throw error;
  }
  await appendTickLog(entry);
  return entry;
}

// Used by the dashboard's refresh button: safe to call often, since it only
// runs a real tick when the last one is older than MIN_TICK_GAP_MS.
export async function runTickIfDue({ reason = 'dashboard' } = {}) {
  const [last] = await readTickLog();
  const lastMs = last ? new Date(last.startedAt).getTime() : 0;
  if (Date.now() - lastMs < MIN_TICK_GAP_MS) return { skipped: 'recent', lastTickAt: last.startedAt };
  return runTick({ reason });
}

export async function readEngineStatus() {
  const [log, coinsCache, strategyState] = await Promise.all([readTickLog(), readCoinsCache(), getStrategyState()]);
  const last = log[0] || null;
  const lastCompleted = log.find((t) => !t.error) || null;
  const lastTickAt = lastCompleted?.startedAt || null;
  const ageMs = lastTickAt ? Date.now() - new Date(lastTickAt).getTime() : null;
  const halted = strategyState.risk?.haltedUntilMs && strategyState.risk.haltedUntilMs > Date.now();
  return {
    lastTick: last,
    lastTickAt,
    ageMs,
    stale: ageMs == null || ageMs > STALE_AFTER_MS,
    coinsUpdatedAt: coinsCache.updatedAt,
    recentErrors: log.slice(0, 20).filter((t) => t.error || t.symbolsFailed?.length).map((t) => ({
      startedAt: t.startedAt, error: t.error || null, symbolsFailed: t.symbolsFailed || []
    })),
    halt: halted ? { until: new Date(strategyState.risk.haltedUntilMs).toISOString(), reason: strategyState.risk.haltReason } : null
  };
}

// Shared by the Vercel function (api/engine/tick.js) and server.js's local route.
export async function handleTickRequest(req) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'POST only.' } };
  const denied = checkBearer(req, 'ENGINE_TICK_SECRET');
  if (denied) return { status: denied.status, body: { error: denied.error } };
  try {
    const result = await runTick({ reason: req.headers['x-tick-reason'] || 'scheduler' });
    return { status: result.skipped ? 409 : 200, body: result };
  } catch (error) {
    console.error('[engine/tick] failed:', error);
    return { status: 500, body: { error: error.message } };
  }
}
