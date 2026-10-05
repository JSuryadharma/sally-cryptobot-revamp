import { randomUUID } from 'node:crypto';
import { readJson, writeJson, writeJsonMany, tryAcquireLease, releaseLease } from '../storage.js';
import { readCoinsCache, writeCoinsCache } from '../coinsCache.js';
import { readSettings, engineCfgFromSettings } from '../settings.js';
import { getPortfolio, PORTFOLIO_KEY } from '../tradingRobot.js';
import { resolveUsdIdrRate } from '../binanceData.js';
import { NotificationCenter } from '../notifications.js';
import { checkBearer } from '../auth.js';
import { resolveEngineCfg, profilesFor, BTC_SYMBOL } from './config.js';
import { advance, createEngineState } from './core.js';
import { loadLiveSeries } from './candles.js';
import { buildCoinView } from './views.js';
import { entryBlock } from './riskGuard.js';
import { placeStop } from './setups.js';
import { sizePosition } from './sizing.js';
import { openPositionQty, sellPosition } from './ledger.js';
import { predictCoin } from './prediction.js';
import { signalRecords, updateJournal, summarizeOutcomes } from './outcomes.js';
import { updatePaperJournal, summarizePaper, paperCostPct, paperResults } from './paperBreakout.js';
import { decideStrategy, decisionChanged } from './autopilot.js';

const LEASE_NAME = 'engine';
const LEASE_TTL_MS = 120_000;
const TICK_LOG_KEY = 'engine-ticks.json';
export const ENGINE_STATE_KEY = 'engine-state.json';
export const SIGNAL_JOURNAL_KEY = 'signal-journal.json';
export const PAPER_JOURNAL_KEY = 'paper-breakout-journal.json';
export const AUTOPILOT_KEY = 'autopilot.json';
const AUTOPILOT_CHANGES_MAX = 20;
const TICK_LOG_MAX = 300;
const STALE_AFTER_MS = 20 * 60_000;
const SCHEDULE_MS = 5 * 60_000;
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

// The autopilot's latest decision (autopilot.js), with the history of changes.
export async function readAutopilot() {
  return readJson(AUTOPILOT_KEY, null);
}

async function loadContext() {
  const [settings, autopilot] = await Promise.all([readSettings(), readAutopilot()]);
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings, autopilot));
  const [portfolio, storedState, usdIdrRate] = await Promise.all([
    getPortfolio(settings),
    readJson(ENGINE_STATE_KEY, null),
    resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl)
  ]);
  const engineState = storedState?.version === 2 ? storedState : createEngineState();
  return { settings, cfg, portfolio, engineState, usdIdrRate, autopilot };
}

// Brings the paper test up to date, then lets the autopilot pick the strategy
// from it. The first time, the paper test is replayed over every loaded daily
// candle (about 200 days once BTC's 200-day average is available), so the
// autopilot starts with evidence instead of an empty journal.
async function updateAutopilot({ settings, series, previous, nowMs, costPct }) {
  let paperJournal = await readJson(PAPER_JOURNAL_KEY, []);
  const backfill = !previous?.backfilledAt;
  paperJournal = updatePaperJournal(paperJournal, series, settings.watchlist, backfill ? { window: { startMs: 0, endMs: nowMs } } : {});
  const decision = decideStrategy({
    results: paperResults(paperJournal, series, { costPct }),
    btcDaily: series[BTC_SYMBOL]?.['1d'],
    nowMs,
    previous
  });
  const changed = decisionChanged(previous, decision);
  const changes = previous?.changes || [];
  const autopilot = {
    ...decision,
    backfilledAt: previous?.backfilledAt || new Date(nowMs).toISOString(),
    changes: changed ? [{ at: decision.decidedAt, chosen: decision.chosen, paused: decision.paused, why: decision.why }, ...changes].slice(0, AUTOPILOT_CHANGES_MAX) : changes
  };
  return { paperJournal, autopilot, changed: changed && Boolean(previous) };
}

// Every signal the engine flags, taken or skipped, followed until it reaches
// +2R, its stop or its time stop - the record behind "how often is it right".
async function readSignalJournal() {
  return readJson(SIGNAL_JOURNAL_KEY, []);
}

export async function readPredictionAccuracy() {
  const journal = await readSignalJournal();
  return {
    ...summarizeOutcomes(journal),
    since: journal.length ? new Date(journal.at(-1).barTime * 1000).toISOString() : null,
    recent: journal.slice(0, 20)
  };
}

// Paper test of the daily breakout entry (paperBreakout.js). Recorded next to
// the live engine on every pass; it never trades.
export async function readPaperBreakout() {
  const [journal, settings] = await Promise.all([readJson(PAPER_JOURNAL_KEY, []), readSettings()]);
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings));
  return { ...summarizePaper(journal, { costPct: paperCostPct(cfg) }), recent: journal.slice(0, 20) };
}

async function notifyResults(notifications, out, cfg) {
  const labels = profilesFor(cfg);
  for (const tx of out.transactions) {
    if (tx.type === 'BUY') {
      await notifications.notify({
        title: `BUY ${tx.symbol}`,
        message: `${tx.reason} Confidence ${tx.confidencePct ?? 0}% (${labels[tx.profile]?.label || tx.profile}). Stop ${tx.stopPrice}, risk Rp ${Math.round(tx.riskIdr).toLocaleString('id-ID')}.`,
        level: 'info', category: 'trade'
      });
    } else {
      const pnl = Math.round(tx.realizedProfitIdr).toLocaleString('id-ID');
      const r = tx.rMultiple != null ? ` Trade result ${tx.rMultiple}R.` : '';
      await notifications.notify({
        title: `${tx.partial ? 'PARTIAL SELL' : 'SELL'} ${tx.symbol}`,
        message: `${tx.reason} Realized P&L: Rp ${pnl}.${r}`,
        level: tx.realizedProfitIdr >= 0 ? 'success' : 'warning', category: 'trade'
      });
    }
  }
  for (const event of out.riskEvents) {
    await notifications.notify({ title: 'New entries paused', message: `${event.reason}. Open positions keep their stops.`, level: 'warning', category: 'trade' });
  }
}

// One full engine pass. Caller holds the lease.
async function enginePass({ notifications = new NotificationCenter() } = {}) {
  const startedAt = Date.now();
  const context = await loadContext();
  const { settings, portfolio, engineState, usdIdrRate } = context;
  const held = Object.keys(portfolio.positions || {});
  const symbols = [...new Set([...settings.watchlist, ...held, BTC_SYMBOL])];
  const { series, live, errors } = await loadLiveSeries(symbols, { baseUrl: settings.binanceBaseUrl, nowMs: startedAt });
  const { paperJournal, autopilot, changed } = await updateAutopilot({
    settings, series, previous: context.autopilot, nowMs: startedAt, costPct: paperCostPct(context.cfg)
  });
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings, autopilot));

  // Auto-trade off stops new entries only; open positions keep their stops.
  const tradeSymbols = settings.autoTrade.enabled ? settings.watchlist.filter((s) => series[s]) : [];
  const out = advance(engineState, portfolio, series, { nowMs: startedAt, live: true, usdIdrRate, cfg, tradeSymbols });
  portfolio.updatedAt = new Date().toISOString();
  const journal = updateJournal(await readSignalJournal(), signalRecords(out.signals, cfg), series);
  await writeJsonMany({
    [PORTFOLIO_KEY]: portfolio, [ENGINE_STATE_KEY]: engineState, [SIGNAL_JOURNAL_KEY]: journal,
    [PAPER_JOURNAL_KEY]: paperJournal, [AUTOPILOT_KEY]: autopilot
  });
  await notifyResults(notifications, out, cfg);
  if (changed) {
    await notifications.notify({
      title: autopilot.paused ? 'Autopilot paused new buys' : `Autopilot: ${profilesFor(cfg)[autopilot.chosen]?.label || autopilot.chosen}`,
      message: autopilot.summary, level: autopilot.paused ? 'warning' : 'info', category: 'trade'
    });
  }

  const coins = {};
  for (const symbol of new Set([...settings.watchlist, ...held])) {
    if (!series[symbol]) continue;
    coins[symbol] = await buildCoinView({ symbol, series, live, cfg, portfolio, engineState, settings, usdIdrRate, nowMs: startedAt, fills: out.transactions });
  }
  await writeCoinsCache(coins);

  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    barsProcessed: out.barsProcessed,
    symbolsOk: Object.keys(coins).length,
    symbolsFailed: [...new Set(errors.map((e) => e.symbol))].map((symbol) => ({ symbol, error: errors.find((e) => e.symbol === symbol).error })),
    signals: out.signals.slice(0, 40),
    fills: out.transactions.map((t) => ({
      symbol: t.symbol, type: t.type, partial: Boolean(t.partial), price: t.price, profile: t.profile,
      realizedProfitIdr: t.realizedProfitIdr ?? null, rMultiple: t.rMultiple ?? null, reason: t.reason
    })),
    riskEvents: out.riskEvents,
    autopilot: { chosen: autopilot.chosen, paused: autopilot.paused, changed }
  };
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
    entry = { ...(await withEngineLease(() => enginePass())), reason };
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

// Manual paper trade from the coin page. Runs under the lease, then a normal
// engine pass so every view reflects the new position straight away.
export async function runManualTrade(symbol, action) {
  if (action !== 'BUY' && action !== 'SELL') return { status: 400, body: { error: 'action must be BUY or SELL.' } };
  return withEngineLease(async () => {
    const { settings, cfg, portfolio, engineState, usdIdrRate } = await loadContext();
    const { series, live, errors } = await loadLiveSeries([symbol, BTC_SYMBOL], { baseUrl: settings.binanceBaseUrl });
    if (!series[symbol]) return { status: 502, body: { error: `Couldn't load ${symbol} prices: ${errors[0]?.error || 'unknown error'}` } };
    const nowMs = Date.now();
    let result;

    if (action === 'BUY') {
      if (portfolio.positions[symbol]) return { status: 400, body: { error: 'Already holding this coin.' } };
      if (Object.keys(portfolio.positions).length >= cfg.maxOpenPositions) return { status: 400, body: { error: `All ${cfg.maxOpenPositions} position slots are in use.` } };
      const { headline } = predictCoin({ symbol, series, live, cfg: { ...cfg, profiles: { ...cfg.profiles, swing: true } }, portfolio, risk: engineState.risk, symbolState: engineState.symbols?.[symbol], autoTradeOn: true, usdIdrRate, nowMs });
      const profile = profilesFor(cfg)[headline?.profile || 'swing'];
      const closed = series[symbol][profile.triggerTf];
      const last = closed.at(-1);
      const price = live[symbol][profile.triggerTf].close;
      const entry = price * (1 + cfg.slippagePct / 100);
      let low = live[symbol][profile.triggerTf].low;
      for (const c of closed.slice(-cfg.setup.pullbackLookback)) low = Math.min(low, c.low);
      const placed = profile.entry === 'breakout'
        ? { stop: Number((entry - profile.stopAtr * last.atr14).toPrecision(8)) }
        : placeStop(entry, low - cfg.setup.stopBufferAtr * last.atr14, last.atr14, cfg);
      const stop = placed.stop ?? Number((entry - cfg.setup.maxStopAtr * last.atr14).toPrecision(8));
      const sized = sizePosition({ portfolio, entryPrice: entry, stopPrice: stop, usdIdrRate, cfg });
      if (!(sized.qty > 0)) return { status: 400, body: { error: `Can't size this trade: ${sized.reason}.` } };
      result = openPositionQty(portfolio, {
        symbol, profile: profile.key, setup: 'manual', quantity: sized.qty, entryPrice: entry, stopPrice: stop,
        riskIdr: sized.riskIdr, score: null, reason: 'Manual buy - user override.', timeMs: nowMs, barTime: last.time,
        usdIdrRate, roundTripCostPct: cfg.roundTripCostPct
      });
      // The position is managed from the next closed candle on, never the one before the fill.
      const symbolState = (engineState.symbols[symbol] ||= { lastBarTime: {}, cooldownUntilMs: {} });
      symbolState.lastBarTime[profile.triggerTf] = last.time;
    } else {
      const position = portfolio.positions[symbol];
      if (!position) return { status: 400, body: { error: 'No open position to sell.' } };
      const tf = profilesFor(cfg)[position.profile || 'swing']?.triggerTf || '4h';
      const price = live[symbol]?.[tf]?.close ?? position.entryPrice;
      result = sellPosition(portfolio, {
        symbol, price: price * (1 - cfg.slippagePct / 100), reason: 'Manual sell - user override.', exitKind: 'manual',
        timeMs: nowMs, usdIdrRate, roundTripCostPct: cfg.roundTripCostPct
      });
    }

    await writeJsonMany({ [PORTFOLIO_KEY]: portfolio, [ENGINE_STATE_KEY]: engineState });
    const tx = result.transaction;
    const notifications = new NotificationCenter();
    if (tx) {
      const detail = tx.type === 'BUY'
        ? `Bought at ${tx.price}, stop ${tx.stopPrice}.`
        : `Sold at ${tx.price}. P&L: Rp ${Math.round(tx.realizedProfitIdr).toLocaleString('id-ID')}.`;
      await notifications.notify({ title: `Manual ${tx.type} ${symbol}`, message: detail, level: 'info', category: 'trade' });
    }
    const entry = { ...(await enginePass({ notifications })), reason: `manual-${action.toLowerCase()}` };
    if (tx) {
      entry.fills.unshift({
        symbol: tx.symbol, type: tx.type, partial: false, price: tx.price, profile: tx.profile,
        realizedProfitIdr: tx.realizedProfitIdr ?? null, rMultiple: tx.rMultiple ?? null, reason: tx.reason
      });
    }
    await appendTickLog(entry);
    return { status: tx ? 200 : 400, body: tx ? { transaction: tx } : { error: result.note || 'Trade not executed.' } };
  });
}

function activityFrom(log) {
  const items = [];
  const seen = new Set();
  for (const tick of log.slice(0, 60)) {
    const at = tick.startedAt;
    for (const f of tick.fills || []) items.push({ kind: 'fill', at, ...f });
    for (const e of tick.riskEvents || []) items.push({ kind: 'pause', at, reason: e.reason });
    for (const s of tick.signals || []) {
      if (s.taken) continue;
      const key = `${s.symbol}|${s.profile}|${s.barTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ kind: 'skipped', at, symbol: s.symbol, profile: s.profile, score: s.score, reason: s.skip });
    }
  }
  return items.slice(0, 30);
}

export async function readEngineStatus() {
  const [log, coinsCache, settings, storedState, autopilot] = await Promise.all([readTickLog(), readCoinsCache(), readSettings(), readJson(ENGINE_STATE_KEY, null), readAutopilot()]);
  const last = log[0] || null;
  const lastCompleted = log.find((t) => !t.error) || null;
  const lastTickAt = lastCompleted?.startedAt || null;
  const lastMs = lastTickAt ? new Date(lastTickAt).getTime() : null;
  const ageMs = lastMs != null ? Date.now() - lastMs : null;
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings, autopilot));
  const pause = storedState?.risk ? entryBlock(storedState.risk, Date.now(), cfg) : null;
  return {
    lastTick: last,
    lastTickAt,
    ageMs,
    stale: ageMs == null || ageMs > STALE_AFTER_MS,
    nextTickEta: lastMs != null ? new Date(lastMs + SCHEDULE_MS).toISOString() : null,
    autoTradeEnabled: settings.autoTrade.enabled,
    coinsUpdatedAt: coinsCache.updatedAt,
    recentErrors: log.slice(0, 20).filter((t) => t.error || t.symbolsFailed?.length).map((t) => ({
      startedAt: t.startedAt, error: t.error || null, symbolsFailed: t.symbolsFailed || []
    })),
    autopilot,
    halt: pause ? { reason: pause, until: storedState.risk.haltedUntilMs ? new Date(storedState.risk.haltedUntilMs).toISOString() : null, untilEndOfDay: Boolean(storedState.risk.haltDayKey) } : null,
    activity: activityFrom(log)
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
