export const TF_MS = { '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000 };
export const ENGINE_TIMEFRAMES = ['15m', '1h', '4h', '1d'];
export const BTC_SYMBOL = 'BTCUSDT';

// Trend-following profiles with wide ATR trails: the 2024-2026 backtests found
// the edge here comes from letting a few big winners run. Scalping is kept for
// experiments but off by default - on 15m and 1h candles the 0.2% round-trip
// cost was a third of the stop distance and every variant lost money.
export const PROFILES = {
  scalping: {
    key: 'scalping',
    label: 'Scalping (15m, 1h trend) - experimental',
    triggerTf: '15m',
    filterTf: '1h',
    timeStopBars: 16,
    trailAtrMult: 2.0,
    cooldownBars: 8,
    barsPer24h: 96
  },
  swing: {
    key: 'swing',
    label: 'Swing (4h, daily trend)',
    triggerTf: '4h',
    filterTf: '1d',
    timeStopBars: 54,
    trailAtrMult: 3.75,
    cooldownBars: 3,
    barsPer24h: 6
  },
  trend: {
    key: 'trend',
    label: 'Trend (daily)',
    triggerTf: '1d',
    filterTf: '1d',
    timeStopBars: 54,
    trailAtrMult: 3.75,
    cooldownBars: 2,
    barsPer24h: 1
  }
};

// Setup thresholds. Kept separate from the user-facing settings so the
// backtester can sweep them without touching the stored settings.
export const SETUP_PARAMS = {
  pullbackLookback: 5,
  pullbackTouchAtr: 0.25,
  rsiDipMin: 35,
  rsiDipMax: 55,
  chaseMaxAtr: 1.0,
  rsiMax: 70,
  stopBufferAtr: 0.2,
  minStopAtr: 1.0,
  maxStopAtr: 3.0,
  minStopCostMult: 3,
  minAtrPct: 0.2,
  breakoutLookback: 20,
  breakoutVolMult: 1.5,
  breakoutChaseAtr: 2.0,
  breakoutStopAtr: 1.5,
  trendSlopeBars: 5,
  roomLookback: 50
};

export const DEFAULT_ENGINE_CFG = {
  riskPerTradePct: 0.75,
  maxPortfolioRiskPct: 3,
  maxOpenPositions: 4,
  tradeAllocationPct: 0.3,
  roundTripCostPct: 0.2,
  slippagePct: 0.05,
  minConfidencePct: 0,
  minNotionalUsdt: 10,
  minTradeQuoteVolumeUsdt: 20_000_000,
  dailyLossLimitPct: 2,
  maxConsecutiveLosses: 3,
  streakPauseMs: 12 * 60 * 60_000,
  drawdownHaltPct: 10,
  drawdownHaltMs: 3 * 24 * 60 * 60_000,
  partialAtR: 1,
  partialFraction: 0,
  timeStopMinR: 0.5,
  targetR: null,
  trendExit: false,
  maxCatchUpBars: 96,
  enableBreakout: false,
  btcGate: true,
  timeStopMult: 1,
  trailMult: 1,
  timeZone: 'Asia/Jakarta',
  profiles: { scalping: false, swing: true, trend: true },
  setup: SETUP_PARAMS
};

export function resolveEngineCfg(overrides = {}) {
  return {
    ...DEFAULT_ENGINE_CFG,
    ...overrides,
    profiles: { ...DEFAULT_ENGINE_CFG.profiles, ...(overrides.profiles || {}) },
    profileOverrides: overrides.profileOverrides || {},
    setup: { ...SETUP_PARAMS, ...(overrides.setup || {}) }
  };
}

// Profiles with any per-run overrides (e.g. a different trigger timeframe) applied.
const profileCache = new WeakMap();

export function profilesFor(cfg) {
  if (!cfg) return PROFILES;
  let cached = profileCache.get(cfg);
  if (!cached) {
    const overrides = cfg.profileOverrides || {};
    cached = Object.fromEntries(Object.entries(PROFILES).map(([key, p]) => [key, { ...p, ...(overrides[key] || {}) }]));
    profileCache.set(cfg, cached);
  }
  return cached;
}

export function profileTimeStopBars(profile, cfg) {
  return Math.round(profile.timeStopBars * (cfg.timeStopMult ?? 1));
}

export function profileTrailAtr(profile, cfg) {
  return profile.trailAtrMult * (cfg.trailMult ?? 1);
}

// Shape the dashboard's "Indicators" card already renders (strategyParams).
export function describeProfile(profileKey, cfg = DEFAULT_ENGINE_CFG) {
  const profile = PROFILES[profileKey];
  if (!profile) return null;
  const hours = (profileTimeStopBars(profile, cfg) * TF_MS[profile.triggerTf]) / 3_600_000;
  return {
    mode: profileKey,
    label: profile.label,
    emaCrossLabel: 'EMA20 / EMA50 trend, pullback to EMA20',
    rsiLabel: 'RSI14',
    rsiRangeLabel: `dip ${SETUP_PARAMS.rsiDipMin}-${SETUP_PARAMS.rsiDipMax}, entry <= ${SETUP_PARAMS.rsiMax}`,
    slAtrMult: SETUP_PARAMS.minStopAtr,
    tpAtrMult: null,
    maxHoldBars: profileTimeStopBars(profile, cfg),
    holdLabel: `time stop after ${profileTimeStopBars(profile, cfg)} bars (~${hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`}) if not +${cfg.timeStopMinR}R`
  };
}
