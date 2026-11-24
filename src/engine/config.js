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
  // 200-day average, sell at +1R, otherwise exit after 30 days.
  // No breakeven move or trail, and no early entry: the edge was measured on
  // closes.
  breakout: {
    key: 'breakout',
    label: 'Breakout 20-day (daily, BTC above its 50-day average)',
    entry: 'breakout',
    triggerTf: '1d',
    filterTf: '1d',
    breakoutLookback: 20,
    // 3x ATR, not the researched 2x: in the 36-month backtest (2023-10 to
    // 2026-10, 15 coins) the 2x stop shook out many breakouts that dipped
    // before running. See breakout55 below.
    stopAtr: 3,
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
  },
  // The other rule that made money in both research periods: the 55-day high. The autopilot (autopilot.js) runs it instead of the
  // 20-day breakout when the paper test shows it doing better.
  breakout55: {
    key: 'breakout55',
    label: 'Breakout 55-day (daily, BTC above its 50-day average)',
    entry: 'breakout',
    triggerTf: '1d',
    filterTf: '1d',
    breakoutLookback: 55,
    // 36-month backtest (2023-10 to 2026-10, 15 coins, autopilot, 5m exits):
    // 3x ATR stop with +3R returned +145% (PF 2.30, 64% wins, max drawdown
    // 19.8%) vs +65% (PF 1.38, 49% wins, 18.0%) for 2x ATR with +2R, and won
    // in both the first 24 and the last 12 months. The paper test
    // (paperBreakout.js) keeps the researched 2x ATR / +2R as the autopilot's
    // evidence, as in that backtest.
    stopAtr: 3,
    targetR: 3,
    timeStopBars: 30,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 1
  },
  // Trend-following variant (time-travel study 2026-11-21, scripts/timeTravel.mjs):
  // the 20-day breakout with no fixed target, sold when a daily close breaks
  // the prior 10-day low. Off by default.
  breakoutTrail: {
    key: 'breakoutTrail',
    label: 'Breakout 20-day, exit at the 10-day low (daily, BTC above its 50-day average)',
    entry: 'breakout',
    triggerTf: '1d',
    filterTf: '1d',
    breakoutLookback: 20,
    stopAtr: 2,
    targetR: 0,
    channelExitBars: 10,
    timeStopBars: 120,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    trendExit: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 1
  },
  // IDX stocks (markets/idx.js): the same daily breakout, with IHSG above its
  // 50-day average as the regime filter. Bought at the daily close (IDX's
  // post-closing session trades at the closing price), exits checked on daily
  // candles. NOT backtested yet: scripts/idxBacktest.mjs compares variants on
  // Yahoo Finance history and needs a machine that can reach Yahoo.
  idxBreakout: {
    key: 'idxBreakout',
    label: 'IDX breakout 55-day (daily, IHSG above its 50-day average)',
    market: 'idx',
    entry: 'breakout',
    triggerTf: '1d',
    filterTf: '1d',
    // 55-day / 3 ATR / +2R (2026-11-21, scripts/idxBacktest.mjs): beat the old
    // 20-day / 2.5 ATR on BEI OHLC 2021-02..2025-02 (+5.0% vs -4.2%, real IHSG)
    // and on 14 stocks 2024-11..2026-11 (+2.1% vs -1.6%); over 11 years the
    // 20-day made more (+86% vs +69%) with a similar drawdown.
    // Set minSkillSetups: 2 to also require two day-trader-skill setups.
    breakoutLookback: 55,
    stopAtr: 3,
    targetR: 2,
    timeStopBars: 30,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 1
  },
  // IDX dip buy (strategies/dip.js): close above the 200-day average and
  // 2-day RSI under 10; sells at the first close above the 5-day average or
  // after 10 days. No IHSG filter (Joe, 2026-11-24). The 10% disaster stop
  // also sizes the trade (2% risk = about 20% of equity per position).
  // Engine backtest with the breakout (scripts/idxDipBacktest.mjs, 14 stocks,
  // close-only data to 2026-11-20): 15y +125% DD 27% vs breakout alone +32%
  // DD 41%; 1y +9.2% vs +4.2%; 2y +26.3% vs +26.8%. Dip trades won 65-70%.
  // A 15% stop: 15y +68%, 25%: +58%.
  idxDip: {
    key: 'idxDip',
    label: 'IDX dip buy (close above the 200-day average, 2-day RSI under 10)',
    market: 'idx',
    entry: 'dip',
    triggerTf: '1d',
    filterTf: '1d',
    trendSmaBars: 200,
    rsiBars: 2,
    rsiMax: 10,
    smaExitBars: 5,
    dipStopPct: 10,
    targetR: 0,
    timeStopBars: 10,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    trendExit: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 1
  },
  // Crypto dip buy (strategies/dip.js, selling climax): daily close under the
  // lower Bollinger band (20, 2) on at least 2x the 20-day volume; sells at
  // the first higher daily close or after 10 days; disaster stop under the
  // entry. Not chosen by the autopilot (market: 'crypto' keeps it out).
  // Signal study (16 coins, daily, 2023-2026, train to 2024-12): 72.9% wins
  // vs 51.1% needed (z 4.27, 96 trades), test 72.7% vs 54.9% (z 3.95, 121
  // trades), +1.6 to +2.1% per trade. The IDX rule (RSI2 under 10 above the
  // 200-day) was not significant on crypto (test z 1.59) and lost in the
  // engine. Engine backtest with the live robot (scripts/cryptoDipBacktest.mjs,
  // Rp 20M, to 2026-11-21): 3y +207% DD 14.6% vs +179% DD 16.7%; 1y +40.7% vs
  // +31.0%; 6m +29.4% vs +31.0%; 3m +1.7% vs -0.5%. Dip trades won 67-88%.
  // A 25% stop beat 15% (3y +216%, 6m +22.5%) and 10% (3y +201%, DD 18.1%).
  cryptoDip: {
    key: 'cryptoDip',
    label: 'Crypto dip buy (close under the lower Bollinger band on 2x volume)',
    market: 'crypto',
    entry: 'dip',
    triggerTf: '1d',
    filterTf: '1d',
    climaxVolMult: 2,
    firstUpExit: true,
    dipStopPct: 25,
    targetR: 0,
    timeStopBars: 10,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    trendExit: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 1
  },
  // Gap rebound (paperGap.js has the rule; scripts/gapResearch.mjs the
  // research). Runs next to the breakouts, not chosen by the autopilot, and
  // has its own on/off switch in Settings. Buys a 1h rebound (RSI back from
  // under 30, first close above EMA20) under a daily gap that formed on at
  // least 2x volume; stop under the 24h low, never more than 15% away;
  // +1.5R from the planned stop; sells after 7 days otherwise. 0.5% risk.
  // 3-year engine backtest (2023-12 to 2026-11, 16 coins, one account with the
  // breakouts): 0.5% risk +143.4% / max DD 21.3%, 1% risk +155.8% / DD 24.4%,
  // breakouts alone +130.0% / DD 18.9%. Last 14 months at 0.5%: +33.8% vs
  // +28.6% at the same 12.3% drawdown. A BTC-above-200d filter made it worse.
  // On its own it only broke even in the first two years.
  gap: {
    key: 'gap',
    label: 'Gap rebound (daily gap on 2x volume, 1h rebound)',
    entry: 'gap',
    triggerTf: '1h',
    filterTf: '1d',
    riskPct: 0.5,
    targetR: 1.5,
    timeStopBars: 168,
    timeStopMinR: Infinity,
    trailAtrMult: null,
    breakeven: false,
    earlyEntry: false,
    // Bought below the EMA50 by design, so the trend-break exit is off.
    trendExit: false,
    cooldownAfterAnyExit: true,
    cooldownBars: 1,
    barsPer24h: 24
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

export const SCALE_IN_AT_STOP = { mode: 'replace', rangeMult: 0, volMult: 0, red: false, addFrac: 0.5, capR: 1.5 };

export const DEFAULT_ENGINE_CFG = {
  // 24-month backtest (2024-10 to 2026-10, 15 coins, 5m exits, autopilot):
  // 2% risk, 6 positions and up to 6 new entries per daily close returned
  // +76% (+33% a year) with a 15.9% max drawdown, PF 1.77. Today's 0.75% risk,
  // 4 positions and 1 entry per close returned +6.8%, drawdown 9.5%. Raising
  // risk alone (still 1 entry per close) mostly raised the drawdown.
  riskPerTradePct: 2,
  // Breakout market filter (paperBreakout.regimeAllows). Since 2026-11-23:
  // BTC alone above its 50-day average (Joe: the 200-day is too slow for
  // today's market). Engine backtest to 2026-11-21, Rp 20M: BTC>50d 3y +174%
  // DD 19.2%, 1y +26.7%, 6m +26.6%, 3m +1.3%; the old BTC-or-coin >200d 3y
  // +179% DD 18.1%, 1y +32.4%, 6m +18.6%, 3m -1.6%. BTC-or-coin >50d was
  // worse than both (3y +153%), so the coin leg was dropped with the switch.
  // 'btc200' means "the market symbol (BTC / IHSG)"; the days come from regimeDays.
  regimeMode: 'btc200',
  regimeDays: 50,
  maxPortfolioRiskPct: 10,
  maxOpenPositions: 6,
  tradeAllocationPct: 0.3,
  roundTripCostPct: 0.2,
  slippagePct: 0.05,
  minConfidencePct: 0,
  minNotionalUsdt: 10,
  minTradeQuoteVolumeUsdt: 20_000_000,
  dailyLossLimitPct: 4,
  maxConsecutiveLosses: 3,
  streakPauseMs: 12 * 60 * 60_000,
  drawdownHaltPct: 25,
  drawdownHaltMs: 3 * 24 * 60 * 60_000,
  partialAtR: 1,
  partialFraction: 0,
  timeStopMinR: 0.5,
  // Exits are the stop-loss and a fixed take-profit: sell the whole position
  // once price reaches entry + targetR x risk. A profile's own targetR wins
  // (breakout: +1R). +1.5R was the best fixed target in the PR #2 exit
  // comparison. The ATR trailing stop and the move to breakeven at +1R are off
  // (Joe, 2026-10-05); the backtest's --exits still compares them.
  targetR: 1.5,
  trailing: false,
  breakevenStop: false,
  trendExit: false,
  maxCatchUpBars: 96,
  // Live only: an entry is taken only while the tick runs within this share of
  // a trigger bar after its close (1h on 4h bars), because the paper fill uses
  // that bar's close. Later ticks record the signal as skipped instead of
  // buying at a stale price.
  maxEntryDelayBarFrac: 0.25,
  // Daily breakouts cluster: several coins often break out on the same close.
  // With 1 entry per close the 24-month backtest dropped most of them (+3.8% a
  // year); taking up to 6 returned +33% a year and won 56% vs 44% of trades.
  // The portfolio risk cap still bounds how much one bad day can cost.
  maxNewEntriesPerBar: 6,
  // Re-check setups on every closed earlyTf candle instead of only at the
  // trigger candle's close (see core.js).
  earlyEntry: false,
  earlyTf: '5m',
  // When the daily breakout buys (core.js breakoutMode). 'touch:b0.75': on
  // live prices, the first 5m close that clears the prior N-day high by 0.75
  // daily ATR (a clean break), with no wait for the daily close.
  // 37-month backtest (2023-10 to 2026-11, 15 coins, autopilot, 5m exits,
  // 2% risk): +167%, max drawdown 12.0%, PF 2.54, vs +148% / 20.1% / 2.14
  // buying the daily close and +189% / 21.8% / 2.08 buying the first touch.
  // Any margin from 0.4 to 1 ATR kept the drawdown at 12-15.5% (returns
  // +135% to +184%); a volume spike or a 15m/1h candle close did not help.
  // 'close' restores the old rule, 'touch' buys the bare break.
  breakoutEntry: 'touch:b0.75',
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
  // entry research, so breakout is the only strategy on by default. Live, the
  // autopilot (autopilot.js) picks the profiles on every tick.
  profiles: { scalping: false, swing: false, trend: false, breakout: true, breakout55: false, breakoutTrail: false, gap: true, cryptoDip: true },
  // Set by the autopilot when every candidate strategy is losing in the paper
  // test: signals are still recorded, but no new position is opened.
  autopilotPause: null,
  // Scale-in at the stop (engine/dca.js), the default since 2026-11-23 (Joe):
  // when a breakout reaches its 3-ATR stop, buy 0.5x the first lot at that 5m
  // close instead of selling and move the stop to where all lots lose 1.5R
  // (about 4 ATR under entry); the target stays. 36-month engine backtest to
  // 2026-11-21: +306% / DD 16.7% vs +193% / 15.9% with the plain stop; last
  // 14 months +70.9% / 12.8% vs +43.9% / 13.3%. A failed trade loses 1.5R.
  // Spike/volume-triggered DCA was tested and had no edge
  // (docs/research/dca-spike-2026-11-23.md). null = the plain stop.
  dca: SCALE_IN_AT_STOP,
  setup: SETUP_PARAMS
};

// day-trader-skill's risk manager limits (engine/preTradeCheck.js), on for
// crypto since 2026-11-21: in scripts/skillEngineBacktest.mjs (36 months to
// 2026-11-15) it lifted the robot from +143% / DD 21.3% to +172% / DD 15.9%;
// the last 14 months were unchanged (+33.9% vs +33.8%). The gain comes from
// the reward:risk rule, which blocks the 20-day breakout's +1R target after
// costs (the daily limits alone: +131% / DD 22.9%). Pass preTrade: null to turn it off.
export function skillGate(riskPerTradePct = DEFAULT_ENGINE_CFG.riskPerTradePct) {
  return { minRewardRisk: 1, maxLossPerTradePct: Math.max(riskPerTradePct * 1.25, 0.5), maxDailyRiskPct: 6, maxTradesPerDay: 3, cashBufferPct: 10 };
}

export function resolveEngineCfg(overrides = {}) {
  return {
    ...DEFAULT_ENGINE_CFG,
    preTrade: skillGate(overrides.riskPerTradePct ?? DEFAULT_ENGINE_CFG.riskPerTradePct),
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

// The market's regime filter for the breakout: BTC for crypto, IHSG for IDX
// stocks (markets/idx.js sets cfg.regimeSymbol and cfg.regimeLabel).
export function regimeSymbolOf(cfg) {
  return cfg?.regimeSymbol || BTC_SYMBOL;
}

export function regimeLabelOf(cfg) {
  return cfg?.regimeLabel || 'BTC';
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
  if (cfg.trailing === false) return null;
  return profile.trailAtrMult ? profile.trailAtrMult * (cfg.trailMult ?? 1) : null;
}

// Whether the stop moves to breakeven once the trade is +partialAtR R.
export function profileBreakeven(profile, cfg) {
  return profile.breakeven !== false && cfg.breakevenStop !== false;
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
  if (profile.entry === 'gap') {
    return {
      mode: profileKey,
      label: profile.label,
      emaCrossLabel: 'daily gap on 2x volume, then 1h close back above EMA20',
      rsiLabel: 'RSI14 (1h)',
      rsiRangeLabel: 'under 30 in the last 24h, back above 40',
      slAtrMult: 0.5,
      tpAtrMult: null,
      maxHoldBars: profileTimeStopBars(profile, cfg),
      holdLabel: `sell at +${profile.targetR}R, max loss 15%, otherwise after 7 days`
    };
  }
  if (profile.entry === 'breakout') {
    return {
      mode: profileKey,
      label: profile.label,
      emaCrossLabel: `close above the prior ${profile.breakoutLookback}-day high, BTC above its ${cfg?.regimeDays ?? 50}-day average`,
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
    holdLabel: `${profileTargetR(profile, cfg) ? `sell at +${profileTargetR(profile, cfg)}R, otherwise ` : ''}time stop after ${profileTimeStopBars(profile, cfg)} bars (~${hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`}) if not +${cfg.timeStopMinR}R`
  };
}
