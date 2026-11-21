import { randomUUID } from 'node:crypto';
import { readJson, writeJson, writeJsonMany, tryAcquireLease, releaseLease } from '../storage.js';
import { readCoinsCache, writeCoinsCache } from '../coinsCache.js';
import { readSettings, engineCfgFromSettings } from '../settings.js';
import { getPortfolio, PORTFOLIO_KEY } from '../tradingRobot.js';
import { syncStartingBalance } from './deposit.js';
import { reconcileBrokers } from '../brokers/execution.js';
import { buildOrderList } from './orderPlans.js';
import { regimeAllows } from './paperBreakout.js';
import { resolveUsdIdrRate } from '../binanceData.js';
import { NotificationCenter } from '../notifications.js';
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
import { updateGapJournal, summarizeGap } from './paperGap.js';
import { bookView } from '../account.js';
import { idxPass, IDX_STATE_KEY, IDX_CACHE_KEY } from './idxPass.js';
import { loadIdxSeries, idxEngineCfg, IDX_REGIME_SYMBOL } from '../markets/idx.js';
import { positionOdds, breakoutPlans, scannerFor } from './insights.js';
import { refreshNews, priceHistoryFrom, NEWS_JOURNAL_KEY, PRICE_HISTORY_KEY, NEWS_REFRESH_MS } from '../news/service.js';

const LEASE_NAME = 'engine';
const LEASE_TTL_MS = 120_000;
export const TICK_LOG_KEY = 'engine-ticks.json';
export const ENGINE_STATE_KEY = 'engine-state.json';
export const SIGNAL_JOURNAL_KEY = 'signal-journal.json';
export const PAPER_JOURNAL_KEY = 'paper-breakout-journal.json';
export const AUTOPILOT_KEY = 'autopilot.json';
export const GAP_JOURNAL_KEY = 'paper-gap-journal.json';
export const CRYPTO_INSIGHTS_KEY = 'crypto-insights.json';
export const NEWS_STATE_KEY = 'news-state.json';
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
  const [portfolio, storedState, usdIdrRate, idxState] = await Promise.all([
    getPortfolio(settings),
    readJson(ENGINE_STATE_KEY, null),
    resolveUsdIdrRate(settings.usdIdrRate, settings.binanceBaseUrl),
    readJson(IDX_STATE_KEY, null)
  ]);
  const engineState = storedState?.version === 2 ? storedState : createEngineState();
  return { settings, cfg, portfolio, engineState, usdIdrRate, autopilot, idxState };
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
    nowMs
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

// Paper test of the gap-rebound entry (paperGap.js). Recorded on every pass
// next to the live engine; it never trades.
export async function readPaperGap() {
  const [journal, settings] = await Promise.all([readJson(GAP_JOURNAL_KEY, []), readSettings()]);
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings));
  return { ...summarizeGap(journal, { costPct: paperCostPct(cfg) }), recent: journal.slice(0, 20) };
}

async function notifyResults(notifications, out, cfg, prefix = '') {
  const labels = profilesFor(cfg);
  for (const tx of out.transactions) {
    if (tx.type === 'BUY') {
      await notifications.notify({
        title: `${prefix}BUY ${tx.symbol}`,
        message: `${tx.reason} Confidence ${tx.confidencePct ?? 0}% (${labels[tx.profile]?.label || tx.profile}). Stop ${tx.stopPrice}, risk Rp ${Math.round(tx.riskIdr).toLocaleString('id-ID')}.`,
        level: 'info', category: 'trade'
      });
    } else {
      const pnl = Math.round(tx.realizedProfitIdr).toLocaleString('id-ID');
      const r = tx.rMultiple != null ? ` Trade result ${tx.rMultiple}R.` : '';
      await notifications.notify({
        title: `${prefix}${tx.partial ? 'PARTIAL SELL' : 'SELL'} ${tx.symbol}`,
        message: `${tx.reason} Realized P&L: Rp ${pnl}.${r}`,
        level: tx.realizedProfitIdr >= 0 ? 'success' : 'warning', category: 'trade'
      });
    }
  }
  for (const event of out.riskEvents) {
    await notifications.notify({ title: `${prefix}New entries paused`, message: `${event.reason}. Open positions keep their stops.`, level: 'warning', category: 'trade' });
  }
}

// One full engine pass. Caller holds the lease.
async function enginePass({ notifications = new NotificationCenter(), forceIdx = false } = {}) {
  const startedAt = Date.now();
  const context = await loadContext();
  const { settings, portfolio, engineState, usdIdrRate } = context;
  const deposit = syncStartingBalance(portfolio, settings.initialBalanceIdr, [engineState.risk, context.idxState?.engine?.risk]);
  if (deposit) await notifications.notify({ title: `Starting balance set to Rp ${settings.initialBalanceIdr.toLocaleString('id-ID')}`, message: `Cash ${deposit > 0 ? '+' : ''}${deposit.toLocaleString('id-ID')} IDR. Open positions unchanged.`, level: 'info', category: 'system' });
  // Crypto trades its own book; cash is shared with the IDX book (account.js).
  const cryptoBook = bookView(portfolio, 'crypto');
  const held = Object.keys(portfolio.positions || {});
  const symbols = [...new Set([...settings.watchlist, ...held, BTC_SYMBOL])];
  const { series, live, errors } = await loadLiveSeries(symbols, { baseUrl: settings.binanceBaseUrl, nowMs: startedAt });
  const { paperJournal, autopilot, changed } = await updateAutopilot({
    settings, series, previous: context.autopilot, nowMs: startedAt, costPct: paperCostPct(context.cfg)
  });
  const cfg = resolveEngineCfg(engineCfgFromSettings(settings, autopilot));

  // Auto-trade off stops new entries only; open positions keep their stops.
  const tradeSymbols = settings.autoTrade.enabled ? settings.watchlist.filter((s) => series[s]) : [];
  const out = advance(engineState, cryptoBook, series, { nowMs: startedAt, live: true, usdIdrRate, cfg, tradeSymbols });
  for (const tx of out.transactions) tx.market = 'crypto';

  // IDX stocks: same engine, own book, shared cash. A data or code failure here
  // never stops the crypto half.
  let idx = null;
  let idxError = null;
  try {
    idx = await idxPass({ settings, portfolio, nowMs: startedAt, stored: context.idxState, force: forceIdx });
  } catch (error) {
    idxError = error.message;
    console.warn('[engine] IDX pass failed:', error.message);
  }
  portfolio.updatedAt = new Date().toISOString();
  const journal = updateJournal(await readSignalJournal(), signalRecords(out.signals, cfg), series);
  const gapJournal = updateGapJournal(await readJson(GAP_JOURNAL_KEY, []), series, settings.watchlist);

  // Scanner and time-machine odds (day-trader-skill ports) for the crypto side.
  const activeProfile = cfg.profiles?.breakout55 ? 'breakout55' : 'breakout';
  const cryptoInsights = {
    updatedAt: new Date(startedAt).toISOString(),
    scanner: scannerFor(Object.fromEntries(Object.entries(series).filter(([s]) => settings.watchlist.includes(s))), { minValue: settings.minTradeQuoteVolumeUsdt }).slice(0, 20),
    odds: positionOdds({ positions: cryptoBook.positions, series, live, cfg }),
    plans: breakoutPlans({ symbols: settings.watchlist, series, live, cfg, profileKey: activeProfile })
  };
  {
    const prices = Object.fromEntries(Object.keys(series).map((s) => [s, live?.[s]?.['5m']?.close ?? live?.[s]?.['1d']?.close ?? series[s]['1d']?.at(-1)?.close]));
    const equityIdr = portfolio.balanceIdr + [...Object.values(portfolio.positions || {}), ...Object.values(portfolio.books?.idx?.positions || {})].reduce((t, p) => t + (p.investedIdr || 0), 0);
    cryptoInsights.orders = buildOrderList({
      market: 'crypto', plans: cryptoInsights.plans, prices, positions: cryptoBook.positions, cfg, equityIdr, cashIdr: portfolio.balanceIdr, usdIdrRate, nowMs: startedAt,
      allowed: (s) => { const d = series[s]?.['1d']; return Boolean(d?.length) && regimeAllows(cfg, series[BTC_SYMBOL]?.['1d'], d, d.at(-1).time); }
    });
  }

  // Daily closes for the news correlation, and the news itself every 15 minutes.
  const previousHistory = await readJson(PRICE_HISTORY_KEY, {});
  const priceHistory = { crypto: priceHistoryFrom(series), idx: idx ? priceHistoryFrom(idx.series) : (previousHistory.idx || {}) };
  const newsWrites = await maybeRefreshNews(settings, startedAt);

  await writeJsonMany({
    [PORTFOLIO_KEY]: portfolio, [ENGINE_STATE_KEY]: engineState, [SIGNAL_JOURNAL_KEY]: journal,
    [PAPER_JOURNAL_KEY]: paperJournal, [AUTOPILOT_KEY]: autopilot, [GAP_JOURNAL_KEY]: gapJournal,
    [CRYPTO_INSIGHTS_KEY]: cryptoInsights, [PRICE_HISTORY_KEY]: priceHistory,
    ...(deposit && context.idxState ? { [IDX_STATE_KEY]: context.idxState } : {}),
    ...(idx?.writes || {}), ...newsWrites
  });
  // Real-money copy of the robot's positions (off unless configured; docs/LIVE-TRADING.md).
  let broker = null;
  try { broker = await reconcileBrokers({ portfolio, settings, usdIdrRate, notifications }); } catch (error) { console.warn('[broker] reconcile failed:', error.message); }
  await notifyResults(notifications, out, cfg);
  if (idx) await notifyResults(notifications, idx.out, idx.cfg, 'IDX ');
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
    autopilot: { chosen: autopilot.chosen, paused: autopilot.paused, changed },
    idx: idx ? {
      ran: true,
      symbolsOk: Object.keys(idx.cache.stocks).length,
      symbolsFailed: idx.cache.errors,
      fills: idx.cache.fills.map((f) => ({ ...f, market: 'idx' }))
    } : { ran: false, error: idxError }
  };
}

async function maybeRefreshNews(settings, nowMs) {
  try {
    const state = await readJson(NEWS_STATE_KEY, null);
    if (state?.lastRunMs && nowMs - state.lastRunMs < NEWS_REFRESH_MS) return {};
    const { journal, added, errors, feeds } = await refreshNews(await readJson(NEWS_JOURNAL_KEY, []), {
      watchlists: { crypto: settings.watchlist, idx: settings.idx?.enabled ? settings.idx.watchlist : [] }, nowMs
    });
    return { [NEWS_JOURNAL_KEY]: journal, [NEWS_STATE_KEY]: { lastRunMs: nowMs, added, errors, feeds } };
  } catch (error) {
    console.warn('[news] refresh failed:', error.message);
    return {};
  }
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
    const { settings, cfg, portfolio: account, engineState, usdIdrRate } = await loadContext();
    const portfolio = bookView(account, 'crypto');
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

    if (result.transaction) result.transaction.market = 'crypto';
    await writeJsonMany({ [PORTFOLIO_KEY]: account, [ENGINE_STATE_KEY]: engineState });
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
    for (const f of tick.idx?.fills || []) items.push({ kind: 'fill', at, ...f, market: 'idx' });
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
  try {
    const result = await runTick({ reason: req.headers['x-tick-reason'] || 'scheduler' });
    return { status: result.skipped ? 409 : 200, body: result };
  } catch (error) {
    console.error('[engine/tick] failed:', error);
    return { status: 500, body: { error: error.message } };
  }
}

// Manual paper trade on an IDX stock: BUY at the latest price with the IDX
// breakout's 2.5 ATR stop and +2R target, sized in whole lots from the shared
// cash; SELL closes the position. Then a pass with a forced IDX refresh.
export async function runIdxManualTrade(symbol, action) {
  if (action !== 'BUY' && action !== 'SELL') return { status: 400, body: { error: 'action must be BUY or SELL.' } };
  return withEngineLease(async () => {
    const { settings, portfolio: account } = await loadContext();
    if (!settings.idx?.enabled) return { status: 400, body: { error: 'IDX trading is off in Settings.' } };
    const book = bookView(account, 'idx');
    const cfg = idxEngineCfg(settings);
    const { series, live, errors } = await loadIdxSeries([symbol, IDX_REGIME_SYMBOL]);
    const daily = series[symbol]?.['1d'];
    if (!daily?.length) return { status: 502, body: { error: `Couldn't load ${symbol}: ${errors[0]?.error || 'no data'}` } };
    const nowMs = Date.now();
    const price = live[symbol]?.['1d']?.close ?? daily.at(-1).close;
    let result;
    if (action === 'BUY') {
      if (book.positions[symbol]) return { status: 400, body: { error: 'Already holding this stock.' } };
      if (Object.keys(book.positions).length >= cfg.maxOpenPositions) return { status: 400, body: { error: `All ${cfg.maxOpenPositions} IDX position slots are in use.` } };
      const profile = profilesFor(cfg).idxBreakout;
      const entry = price * (1 + cfg.slippagePct / 100);
      const stop = Number((entry - profile.stopAtr * daily.at(-1).atr14).toPrecision(8));
      const sized = sizePosition({ portfolio: book, entryPrice: entry, stopPrice: stop, usdIdrRate: 1, cfg });
      if (!(sized.qty > 0)) return { status: 400, body: { error: `Can't size this trade: ${sized.reason}.` } };
      result = openPositionQty(book, {
        symbol, profile: profile.key, setup: 'manual', quantity: sized.qty, entryPrice: entry, stopPrice: stop,
        riskIdr: sized.riskIdr, score: null, reason: 'Manual buy - user override.', timeMs: nowMs, barTime: daily.at(-1).time,
        usdIdrRate: 1, roundTripCostPct: cfg.roundTripCostPct
      });
    } else {
      if (!book.positions[symbol]) return { status: 400, body: { error: 'No open position to sell.' } };
      result = sellPosition(book, {
        symbol, price: price * (1 - cfg.slippagePct / 100), reason: 'Manual sell - user override.', exitKind: 'manual',
        timeMs: nowMs, usdIdrRate: 1, roundTripCostPct: cfg.roundTripCostPct
      });
    }
    const tx = result.transaction;
    if (tx) tx.market = 'idx';
    await writeJsonMany({ [PORTFOLIO_KEY]: account });
    const notifications = new NotificationCenter();
    if (tx) {
      const detail = tx.type === 'BUY' ? `Bought ${tx.quantity / 100} lot at ${tx.price}, stop ${tx.stopPrice}.` : `Sold at ${tx.price}. P&L: Rp ${Math.round(tx.realizedProfitIdr).toLocaleString('id-ID')}.`;
      await notifications.notify({ title: `Manual IDX ${tx.type} ${symbol}`, message: detail, level: 'info', category: 'trade' });
    }
    const entryLog = { ...(await enginePass({ notifications, forceIdx: true })), reason: `manual-idx-${action.toLowerCase()}` };
    if (tx) entryLog.fills.unshift({ symbol, type: tx.type, partial: false, price: tx.price, profile: tx.profile, market: 'idx', realizedProfitIdr: tx.realizedProfitIdr ?? null, rMultiple: tx.rMultiple ?? null, reason: tx.reason });
    await appendTickLog(entryLog);
    return { status: tx ? 200 : 400, body: tx ? { transaction: tx } : { error: result.note || 'Trade not executed.' } };
  });
}

export async function readIdx() {
  const [cache, state, settings] = await Promise.all([readJson(IDX_CACHE_KEY, null), readJson(IDX_STATE_KEY, null), readSettings()]);
  return {
    enabled: Boolean(settings.idx?.enabled), autoTrade: Boolean(settings.idx?.autoTrade), watchlist: settings.idx?.watchlist || [],
    lastRunAt: state?.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
    risk: state?.engine?.risk ? { haltReason: state.engine.risk.haltReason || null, preTrade: state.engine.preTrade || null } : null,
    recentFills: state?.recentFills || [],
    ...(cache || { stocks: {}, scanner: [], odds: {}, ihsg: null, errors: [] }),
    stocks: Object.values(cache?.stocks || {})
  };
}

export async function readCryptoInsights() {
  return readJson(CRYPTO_INSIGHTS_KEY, { scanner: [], odds: {}, plans: {} });
}
