import { readJson, writeJson } from './storage.js';
import { RR_TEMPLATES, STRATEGY_PARAMS } from './decisionEngine.js';

const SETTINGS_FILE = 'settings.json';

// null (the default) = fully automatic: robotEngine.js picks swing/scalping/
// dayTrade per coin from aiAdvisor.js's recommendMode() (daily ADX/ATR
// regime). Setting this to one of the STRATEGY_PARAMS keys pins EVERY
// watchlist coin to that mode's rules regardless of what the regime picker
// would otherwise recommend - e.g. forcing 'scalping' means every coin is
// evaluated on 15m EMA9/21 + RSI7, even on a day the daily trend is strong
// enough that recommendMode() would have picked swing. This only affects
// which mode is used to open a NEW position; a coin already holding a
// position keeps trading under the mode it was bought under (see
// robotEngine.js) so an override never silently moves a live trade's stop/target.
const MODE_OVERRIDE_VALUES = [null, ...Object.keys(STRATEGY_PARAMS)];

// Everything the app needs to run its own business logic lives here now,
// not in .env - watchlist, trading parameters, Binance's base URL, Telegram,
// and the OpenAI advisor are all DB-backed and editable at runtime from the
// Settings page. Only DATABASE_URL (and PORT, which can't live in the
// database - see config.js) stays in .env.
function defaultSettings() {
  return {
    watchlist: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
    autoTrade: {
      enabled: true,
      // Gate on ENTRIES only - a signal below this confidence is logged but
      // not executed. Exits (stop/target/max-hold/trend-reversal) always
      // execute regardless, on purpose: gating a stop-loss by confidence
      // would mean a "low confidence" reading could leave a losing position
      // open past its own risk plan, which defeats the point of a stop.
      minConfidencePct: 55,
      riskRewardTemplate: 'balanced',
      // See MODE_OVERRIDE_VALUES above. null = automatic regime-based pick.
      modeOverride: null
    },
    telegram: { enabled: true, botToken: '', chatId: '', categories: ['trade', 'ai-review'] },
    // Optional AI advisor - default "local" mode is deterministic rule-based
    // summarization (works immediately, no key, no cost). Switch mode to
    // "openai" + set an API key to get a natural-language paragraph layered
    // on top of the same computed indicators. openaiBaseUrl is overridable
    // for an OpenAI-compatible proxy/gateway, not just api.openai.com itself.
    ai: {
      mode: 'local',
      openaiBaseUrl: 'https://api.openai.com/v1/responses',
      openaiApiKey: '',
      model: 'gpt-4.1-mini'
    },
    binanceBaseUrl: 'https://data-api.binance.vision',
    timeZone: 'Asia/Jakarta',
    // Paper trading only - this never sends a real order to Binance.
    initialBalanceIdr: 10_000_000,
    usdIdrRate: 16800,
    tradeAllocationPct: 0.3,
    maxOpenPositions: 4,
    roundTripCostPct: 0.2,
    refreshIntervalSec: 60,
    topMoversCount: 6,
    minQuoteVolumeUsdt: 5_000_000
  };
}

const AI_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'];

// Matches a real Binance USDT pair, e.g. BTCUSDT (3-char ticker), DOGEUSDT (4),
// MATICUSDT (5). Bug fix: this used to require a 5-15 char ticker before
// "USDT", which rejected every short ticker - including BTC/ETH/BNB/SOL/XRP,
// the app's own default watchlist - so ANY write through here (adding a coin,
// or the Market tab auto-adding a tapped mover) filtered the whole list down
// to nothing and fell back to defaults, which looked like "my watchlist got
// wiped" and "adding a coin does nothing." Most real tickers are 2-4 chars,
// so the minimum here is 1.
const SYMBOL_PATTERN = /^[A-Z0-9]{1,17}USDT$/;

// v5 of the 2026-09 revamp ladder (see the delivered "Robocrypto Revamp"
// report): drops the coins whose daily ATR% sat far outside the rest of the
// benchmarked watchlist (LSK 62.6%, VTHO 23.7%, ASTR 10%+, versus 2.6-8.5%
// for the rest) - the backtest found these three erratic enough to hurt the
// system's overall numbers regardless of which entry/exit logic was paired
// with them. There is no direct DB write access available to curate the
// live watchlist row itself, so this is enforced as a code-level filter
// instead: any of these three landing in the watchlist (via Settings, or
// the Market tab's tap-to-add) is silently dropped here rather than traded.
const EXCLUDED_SYMBOLS = ['LSKUSDT', 'VTHOUSDT', 'ASTRUSDT'];

function boundedList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = [...new Set(value.map((v) => String(v).toUpperCase().trim()).filter((v) => SYMBOL_PATTERN.test(v) && !EXCLUDED_SYMBOLS.includes(v)))];
  return cleaned.length ? cleaned.slice(0, 20) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

// watchlistFallback lets a caller that already has a known-good current
// watchlist (updateSettings, below) fall back to THAT instead of the
// built-in defaults if something in the patch turns out invalid - so a bad
// or unlucky write degrades to "keep what you had," never a silent reset to
// BTC/ETH/BNB/SOL/XRP.
function normalize(raw, watchlistFallback) {
  const base = defaultSettings();
  return {
    watchlist: boundedList(raw.watchlist, watchlistFallback || base.watchlist),
    autoTrade: {
      enabled: raw.autoTrade?.enabled !== false,
      minConfidencePct: boundedNumber(raw.autoTrade?.minConfidencePct, base.autoTrade.minConfidencePct, 0, 100),
      riskRewardTemplate: RR_TEMPLATES[raw.autoTrade?.riskRewardTemplate] ? raw.autoTrade.riskRewardTemplate : base.autoTrade.riskRewardTemplate,
      modeOverride: MODE_OVERRIDE_VALUES.includes(raw.autoTrade?.modeOverride ?? null) ? (raw.autoTrade?.modeOverride ?? null) : base.autoTrade.modeOverride
    },
    telegram: {
      enabled: raw.telegram?.enabled !== false,
      // Never let an empty field submitted by the client wipe out a token/chat ID
      // that's already stored - the same "don't clobber a secret with blank" rule
      // robotrader's settings.js follows.
      botToken: raw.telegram?.botToken || base.telegram.botToken,
      chatId: raw.telegram?.chatId || base.telegram.chatId,
      categories: Array.isArray(raw.telegram?.categories) && raw.telegram.categories.length
        ? raw.telegram.categories.filter((c) => typeof c === 'string')
        : base.telegram.categories
    },
    ai: {
      mode: raw.ai?.mode === 'openai' ? 'openai' : 'local',
      openaiBaseUrl: isHttpUrl(raw.ai?.openaiBaseUrl) ? raw.ai.openaiBaseUrl : base.ai.openaiBaseUrl,
      // Same "don't clobber a secret with blank" rule as the Telegram token above.
      openaiApiKey: raw.ai?.openaiApiKey || base.ai.openaiApiKey,
      model: typeof raw.ai?.model === 'string' && raw.ai.model.trim() ? raw.ai.model.trim() : base.ai.model
    },
    binanceBaseUrl: isHttpUrl(raw.binanceBaseUrl) ? raw.binanceBaseUrl : base.binanceBaseUrl,
    timeZone: typeof raw.timeZone === 'string' && raw.timeZone.trim() ? raw.timeZone.trim() : base.timeZone,
    initialBalanceIdr: boundedNumber(raw.initialBalanceIdr, base.initialBalanceIdr, 100_000, 10_000_000_000),
    usdIdrRate: boundedNumber(raw.usdIdrRate, base.usdIdrRate, 1000, 50_000),
    tradeAllocationPct: boundedNumber(raw.tradeAllocationPct, base.tradeAllocationPct, 0.01, 1),
    maxOpenPositions: boundedNumber(raw.maxOpenPositions, base.maxOpenPositions, 1, 20),
    roundTripCostPct: boundedNumber(raw.roundTripCostPct, base.roundTripCostPct, 0, 5),
    refreshIntervalSec: boundedNumber(raw.refreshIntervalSec, base.refreshIntervalSec, 10, 3600),
    topMoversCount: boundedNumber(raw.topMoversCount, base.topMoversCount, 1, 20),
    minQuoteVolumeUsdt: boundedNumber(raw.minQuoteVolumeUsdt, base.minQuoteVolumeUsdt, 0, 1_000_000_000)
  };
}

export async function readSettings() {
  const stored = await readJson(SETTINGS_FILE, null);
  if (!stored) return defaultSettings();
  const base = defaultSettings();
  return normalize({
    ...base,
    ...stored,
    autoTrade: { ...base.autoTrade, ...stored.autoTrade },
    telegram: { ...base.telegram, ...stored.telegram },
    ai: { ...base.ai, ...stored.ai }
  });
}

export async function updateSettings(patch) {
  const current = await readSettings();
  const merged = {
    ...current,
    ...patch,
    autoTrade: { ...current.autoTrade, ...(patch.autoTrade || {}) },
    telegram: { ...current.telegram, ...(patch.telegram || {}) },
    ai: { ...current.ai, ...(patch.ai || {}) }
  };
  const next = normalize(merged, current.watchlist);
  await writeJson(SETTINGS_FILE, next);
  return next;
}

// Never send secrets to the browser.
export function publicSettings(settings) {
  return {
    watchlist: settings.watchlist,
    autoTrade: settings.autoTrade,
    telegram: {
      enabled: settings.telegram.enabled,
      configured: Boolean(settings.telegram.botToken && settings.telegram.chatId),
      categories: settings.telegram.categories
    },
    ai: {
      mode: settings.ai.mode,
      openaiBaseUrl: settings.ai.openaiBaseUrl,
      model: settings.ai.model,
      configured: Boolean(settings.ai.openaiApiKey),
      availableModels: AI_MODELS
    },
    binanceBaseUrl: settings.binanceBaseUrl,
    timeZone: settings.timeZone,
    initialBalanceIdr: settings.initialBalanceIdr,
    usdIdrRate: settings.usdIdrRate,
    tradeAllocationPct: settings.tradeAllocationPct,
    maxOpenPositions: settings.maxOpenPositions,
    roundTripCostPct: settings.roundTripCostPct,
    refreshIntervalSec: settings.refreshIntervalSec,
    topMoversCount: settings.topMoversCount,
    minQuoteVolumeUsdt: settings.minQuoteVolumeUsdt,
    riskRewardTemplates: RR_TEMPLATES,
    // For the Settings > Strategy mode picker - labels only, same data
    // describeStrategyParams() draws from, so the UI never hardcodes them.
    strategyModes: Object.fromEntries(Object.entries(STRATEGY_PARAMS).map(([key, p]) => [key, { label: p.label }]))
  };
}
