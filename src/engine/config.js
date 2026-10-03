export const TF_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000 };
export const ENGINE_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
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
  },
  // The only entry that made money both on the data it was tuned on and on a
  // later test period (scripts/entryResearch.mjs, 36 months, 2026-09-28), and
  // in the paper test since (paperBreakout.js). Traded exactly as researched:
  // buy the daily close above the prior 20-day high while BTC is above its
  // 200-day average, 2x ATR stop, sell at +1R, otherwise exit after 30 days.
  // No breakeven move or trail, and no early entry: the edge was measured on
  // closes.
  breakout: {
    key: 'breakout',
    label: 'Breakout (daily, BTC above its 200-day average)',
    entry: 'breakout',
    triggerTf: '1d',
    filterTf: '1d',
    breakoutLookback: 20,
    stopAtr: 2,
    targetR: 1,
    timeStopBars: 30,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    // No re-entry on the candle that closed the last trade, as in the research.
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
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
  // Live only: an entry is taken only while the tick runs within this share of
  // a trigger bar after its close (1h on 4h bars), because the paper fill uses
  // that bar's close. Later ticks record the signal as skipped instead of
  // buying at a stale price.
  maxEntryDelayBarFrac: 0.25,
  // Signals on one bar close are mostly the same market move (the majors rise
  // and fall together), so only the best-scoring one is opened per bar close.
  maxNewEntriesPerBar: 1,
  // Re-check setups on every closed earlyTf candle instead of only at the
  // trigger candle's close (see core.js).
  earlyEntry: false,
  earlyTf: '5m',
  // Open positions are checked on every closed exitTf candle: the stop and
  // target against its high/low, and breakeven/trail moves as soon as price
  // gets there. null = only at the 4h/daily close, as before.
  exitTf: '5m',
  enableBreakout: false,
  btcGate: true,
  timeStopMult: 1,
  trailMult: 1,
  timeZone: 'Asia/Jakarta',
  // The 4h/daily pullback (swing, trend) lost money on the test period of the
  // entry research, so breakout is the only strategy on by default.
  profiles: { scalping: false, swing: false, trend: false, breakout: true },
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

// Open positions are managed on every closed cfg.exitTf candle (5m by default)
// when it is shorter than the profile's trigger timeframe; null = trigger close only.
export function exitTfFor(profile, cfg) {
  return cfg.exitTf && TF_MS[cfg.exitTf] && TF_MS[cfg.exitTf] < TF_MS[profile.triggerTf] ? cfg.exitTf : null;
}

export function profileTrailAtr(profile, cfg) {
  return profile.trailAtrMult ? profile.trailAtrMult * (cfg.trailMult ?? 1) : null;
}

// Exit settings a profile can pin regardless of the engine-wide config.
export function profileTargetR(profile, cfg) {
  return profile.targetR ?? cfg.targetR;
}

export function profileTimeStopMinR(profile, cfg) {
  return profile.timeStopMinR ?? cfg.timeStopMinR;
}

// Shape the dashboard's "Indicators" card already renders (strategyParams).
export function describeProfile(profileKey, cfg = DEFAULT_ENGINE_CFG) {
  const profile = PROFILES[profileKey];
  if (!profile) return null;
  const hours = (profileTimeStopBars(profile, cfg) * TF_MS[profile.triggerTf]) / 3_600_000;
  if (profile.entry === 'breakout') {
    return {
      mode: profileKey,
      label: profile.label,
      emaCrossLabel: `close above the prior ${profile.breakoutLookback}-day high, BTC above its 200-day average`,
      rsiLabel: null,
      rsiRangeLabel: null,
      slAtrMult: profile.stopAtr,
      tpAtrMult: null,
      maxHoldBars: profileTimeStopBars(profile, cfg),
      holdLabel: `sell at +${profile.targetR}R, otherwise after ${profileTimeStopBars(profile, cfg)} days`
    };
  }
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
