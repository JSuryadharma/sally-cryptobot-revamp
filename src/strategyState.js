// Persisted state for the revamp-ladder strategy layers added on top of
// decisionEngine.js's original evaluateEntry/evaluateExit: the combined
// EMA-retest/BB-retest entry's armed/waiting state, the structured exit's
// swing-structure/spike-confirmation state, and the portfolio risk-manager's
// day/peak/consecutive-loss bookkeeping. Same Postgres KV backing as
// portfolio.json/settings.json (see storage.js) - a separate key so this
// never collides with either.
import { readJson, writeJson } from './storage.js';

const STATE_FILE = 'strategyState.json';

function defaultState() {
  return {
    // key: `${symbol}:${mode}` -> { combined: {ema:{...}, bb:{...}}, lastBarTime, lastResult }
    entry: {},
    // key: symbol -> { structured: {...}, lastBarTime, lastResult } - keyed by
    // symbol alone (not mode) because a symbol only ever holds one open
    // position at a time, under one mode, matching how
    // scripts/systemBenchmark.mjs keys its own exitStates.
    exit: {},
    // Portfolio-level risk management (see riskManager.js). All wall-clock
    // (Date.now()) based - there is no simulated clock in the live app.
    risk: {
      dayKey: null,
      dayStartBalanceIdr: null,
      peakBalanceIdr: null,
      consecutiveLosses: 0,
      haltedUntilMs: null,
      haltReason: null,
      events: [] // {atMs, reason} - most recent 50 kept, for a future UI/audit view
    }
  };
}

export async function getStrategyState() {
  const stored = await readJson(STATE_FILE, null);
  if (!stored) return defaultState();
  const base = defaultState();
  return {
    entry: stored.entry && typeof stored.entry === 'object' ? stored.entry : base.entry,
    exit: stored.exit && typeof stored.exit === 'object' ? stored.exit : base.exit,
    risk: { ...base.risk, ...(stored.risk || {}) }
  };
}

export async function saveStrategyState(state) {
  await writeJson(STATE_FILE, state);
}
