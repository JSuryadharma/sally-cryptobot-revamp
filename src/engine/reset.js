// Wipes stored data so the paper account starts over. Each scope includes the
// one before it. The stored keys simply go away: every reader already falls
// back to a fresh default (a new portfolio at the starting balance, a new
// engine state, empty journals), and the autopilot replays its paper test
// over the loaded candles on the next tick when its own record is gone.
import { deleteJson } from '../storage.js';
import { PORTFOLIO_KEY } from '../tradingRobot.js';
import { NOTIFICATIONS_FILE, TELEGRAM_STATUS_FILE } from '../notifications.js';
import { SETTINGS_FILE } from '../settings.js';
import { VERDICT_KEY } from '../backtestRunner.js';
import { withEngineLease, TICK_LOG_KEY, ENGINE_STATE_KEY, SIGNAL_JOURNAL_KEY, PAPER_JOURNAL_KEY, AUTOPILOT_KEY } from './tick.js';

const ACCOUNT_KEYS = [PORTFOLIO_KEY, ENGINE_STATE_KEY, TICK_LOG_KEY, NOTIFICATIONS_FILE];
const HISTORY_KEYS = [PAPER_JOURNAL_KEY, AUTOPILOT_KEY, SIGNAL_JOURNAL_KEY, VERDICT_KEY];
const SETTINGS_KEYS = [SETTINGS_FILE, TELEGRAM_STATUS_FILE];

export const RESET_SCOPES = {
  // Balance, trades, risk counters and the activity log.
  account: ACCOUNT_KEYS,
  // Also the paper test, the autopilot's record, prediction history and the backtest verdict.
  history: [...ACCOUNT_KEYS, ...HISTORY_KEYS],
  // Also settings, back to the code defaults.
  everything: [...ACCOUNT_KEYS, ...HISTORY_KEYS, ...SETTINGS_KEYS]
};

// Under the engine lease, so a tick can't write the old portfolio back mid-reset.
export async function resetData(scope, { del = deleteJson, lease = withEngineLease } = {}) {
  const keys = RESET_SCOPES[scope];
  if (!keys) return { status: 400, body: { error: `scope must be one of: ${Object.keys(RESET_SCOPES).join(', ')}.` } };
  return lease(async () => {
    for (const key of keys) await del(key);
    return { status: 200, body: { scope, cleared: keys, at: new Date().toISOString() } };
  });
}
