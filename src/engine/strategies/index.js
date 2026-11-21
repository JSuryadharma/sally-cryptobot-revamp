// Strategy registry. A profile (engine/config.js PROFILES) names its strategy
// with `entry`; profiles without one use the pullback.
//
// A strategy module is a plain object:
//   key                         registry name
//   usesIntrabar(profile, cfg)  true when it also checks closed cfg.earlyTf candles
//   evaluateIntrabar(ctx, event, profile)  -> evaluation with barTime, or null
//   evaluateClose(ctx, event, profile)     -> evaluation at a trigger-candle close, or null
//   followsAutopilot            false when an autopilot pause must not stop it (default true)
//   onFilled(ctx, candidate)    optional bookkeeping after a buy
// An evaluation is { signal: { setup, entryPrice, stopPrice, targetPrice?, score, reason } | null, checklist, armedLevel? }.
//
// Adding a strategy = one new file here + one line below + a profile in
// config.js. The engine loop (core.js), sizing, risk and the ledger stay as they are.
import { breakoutStrategy } from './breakout.js';
import { gapStrategy } from './gap.js';
import { pullbackStrategy } from './pullback.js';

export const STRATEGIES = {
  breakout: breakoutStrategy,
  gap: gapStrategy,
  pullback: pullbackStrategy
};

export function strategyFor(profile) {
  return STRATEGIES[profile?.entry] || pullbackStrategy;
}

export { breakoutMode } from './breakout.js';
