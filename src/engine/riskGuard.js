// Portfolio-level brakes on NEW entries. Exits are never blocked. Pure: the
// caller persists `risk` inside the engine state.

const MAX_EVENTS = 50;

export function createRiskState() {
  return { dayKey: null, dayStartEquityIdr: null, peakEquityIdr: null, consecutiveLosses: 0, haltedUntilMs: null, haltDayKey: null, haltReason: null, events: [] };
}

const formatters = new Map();

export function localDayKey(ms, timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      formatter = null;
    }
    formatters.set(timeZone, formatter);
  }
  return formatter ? formatter.format(new Date(ms)) : new Date(ms).toISOString().slice(0, 10);
}

function pushEvent(risk, atMs, kind, reason) {
  const event = { atMs, kind, reason };
  risk.events = [...(risk.events || []), event].slice(-MAX_EVENTS);
  return event;
}

function halted(risk, nowMs, dayKey) {
  return (risk.haltedUntilMs && nowMs < risk.haltedUntilMs) || (risk.haltDayKey && risk.haltDayKey === dayKey);
}

// Call before evaluating entries at time nowMs. Returns any newly raised halt
// event so the caller can notify about it.
export function updateRisk(risk, equityIdr, nowMs, cfg) {
  const dayKey = localDayKey(nowMs, cfg.timeZone);
  if (dayKey !== risk.dayKey) {
    risk.dayKey = dayKey;
    risk.dayStartEquityIdr = equityIdr;
  }
  risk.peakEquityIdr = Math.max(risk.peakEquityIdr ?? equityIdr, equityIdr);

  if (!halted(risk, nowMs, dayKey)) {
    risk.haltedUntilMs = null;
    risk.haltDayKey = null;
    risk.haltReason = null;
  } else {
    return null;
  }

  const dailyLossPct = risk.dayStartEquityIdr > 0 ? ((risk.dayStartEquityIdr - equityIdr) / risk.dayStartEquityIdr) * 100 : 0;
  const drawdownPct = risk.peakEquityIdr > 0 ? ((risk.peakEquityIdr - equityIdr) / risk.peakEquityIdr) * 100 : 0;
  if (drawdownPct >= cfg.drawdownHaltPct) {
    risk.haltedUntilMs = nowMs + cfg.drawdownHaltMs;
    risk.haltReason = `drawdown ${drawdownPct.toFixed(1)}% from peak (limit ${cfg.drawdownHaltPct}%)`;
    // Reset the peak so the halt does not re-trigger forever once it expires.
    risk.peakEquityIdr = equityIdr;
    return pushEvent(risk, nowMs, 'drawdown', risk.haltReason);
  }
  if (dailyLossPct >= cfg.dailyLossLimitPct) {
    risk.haltDayKey = dayKey;
    risk.haltReason = `daily loss ${dailyLossPct.toFixed(1)}% (limit ${cfg.dailyLossLimitPct}%)`;
    return pushEvent(risk, nowMs, 'daily-loss', risk.haltReason);
  }
  return null;
}

// Call once per fully closed trade with its total realized P&L (partials included).
export function recordTradeResult(risk, tradeRealizedIdr, nowMs, cfg) {
  risk.consecutiveLosses = tradeRealizedIdr <= 0 ? (risk.consecutiveLosses || 0) + 1 : 0;
  if (risk.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    const reason = `${risk.consecutiveLosses} losing trades in a row`;
    risk.consecutiveLosses = 0;
    risk.haltedUntilMs = Math.max(risk.haltedUntilMs || 0, nowMs + cfg.streakPauseMs);
    risk.haltReason = reason;
    return pushEvent(risk, nowMs, 'streak', reason);
  }
  return null;
}

export function entryBlock(risk, nowMs, cfg) {
  const dayKey = localDayKey(nowMs, cfg.timeZone);
  return halted(risk, nowMs, dayKey) ? risk.haltReason || 'entries paused' : null;
}
