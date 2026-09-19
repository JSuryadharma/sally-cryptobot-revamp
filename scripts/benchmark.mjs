// Walk-forward benchmark of the ACTUAL live-trading logic (not a re-implementation
// of it) against real historical Binance data. Reuses decisionEngine.js's
// evaluateEntry/evaluateExit/RR_TEMPLATES and aiAdvisor.js's recommendMode
// directly, so whatever this script reports is exactly what the running app
// would have done - same confidence gate, same regime picker, same ATR
// stop/target sizing. Only the portfolio bookkeeping is re-implemented here
// (copied from tradingRobot.js's math) because that module does file I/O
// against data/portfolio.json, which a benchmark run should never touch.
//
// This needs real internet access to Binance, which this script does not
// have inside a sandboxed session - run it where the live app runs:
//
//   cd robocrypto
//   node scripts/benchmark.mjs --months 3
//
// Optional flags (all default to your current Settings / .env):
//   --months <n>            length of the test window (default 3)
//   --min-confidence <pct>  confidence threshold (default: Settings, else 55)
//   --rr conservative|balanced|aggressive   risk template (default: Settings, else balanced)
//   --symbols BTCUSDT,ETHUSDT,...           coins to test (default: your watchlist)
//   --end <ISO date>        end of the window (default: now)
//
// Output: a console summary plus a full report (summary.json, trades.csv,
// equity-curve.csv) written to benchmarks/<timestamp>/ - separate from
// data/, so this never touches your live paper-trading balance or history.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { enrichCandles } from '../src/indicators.js';
import { evaluateEntry, evaluateExit, RR_TEMPLATES } from '../src/decisionEngine.js';
import { recommendMode } from '../src/aiAdvisor.js';
import { readSettings } from '../src/settings.js';

const INTERVAL_MS = { '1d': 86_400_000, '1h': 3_600_000, '15m': 900_000 };
const INTERVAL_SEC = { swing: 86_400, dayTrade: 3_600, scalping: 900 };
const MODE_TO_INTERVAL = { swing: '1d', dayTrade: '1h', scalping: '15m' };
const WARMUP_BARS = 100; // extra bars before the window so EMA50/ADX14/RSI have stabilized
const TICK_MS = 15 * 60_000; // finest timeframe in play (scalping) - the simulation's clock resolution
const FETCH_TIMEOUT_MS = 15_000;

function round2(value) { return Math.round(value * 100) / 100; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200) || response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Paginates Binance's 1000-candle-per-call limit until [startMs, endMs) is covered.
export async function fetchKlinesRange(baseUrl, symbol, interval, startMs, endMs) {
  const intervalMs = INTERVAL_MS[interval];
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson(url);
    if (!rows.length) break;
    for (const row of rows) {
      out.push({
        time: Math.floor(row[0] / 1000),
        date: new Date(row[0]).toISOString().slice(0, 10),
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
        volume: Number(row[5])
      });
    }
    const nextCursor = rows.at(-1)[0] + intervalMs;
    if (nextCursor <= cursor) break; // guard against a stalled/repeating response
    cursor = nextCursor;
    if (rows.length < 1000) break; // fewer than a full page = reached the end of available data
    await sleep(150); // stay polite to the public endpoint across dozens of paginated calls
  }
  return out;
}

export async function loadHistory(symbol, windowStart, windowEnd, baseUrl) {
  const out = {};
  for (const [mode, interval] of Object.entries(MODE_TO_INTERVAL)) {
    const start = windowStart - WARMUP_BARS * INTERVAL_MS[interval];
    const raw = await fetchKlinesRange(baseUrl, symbol, interval, start, windowEnd);
    out[mode] = enrichCandles(raw);
  }
  return out;
}

// A forward-only cursor into an enriched candle series: advanceTo(tSec) returns
// the snapshot {candles, latest} as of the most recently *closed* candle at or
// before tSec (a candle counts as known once tSec has passed its close time),
// mirroring what the live app would actually have seen at that moment.
export function makeCursor(series, intervalSec) {
  let idx = -1;
  return function advanceTo(tSec) {
    while (idx + 1 < series.length && series[idx + 1].time + intervalSec <= tSec) idx += 1;
    if (idx < 0) return null;
    return { candles: series.slice(0, idx + 1), latest: series[idx] };
  };
}

// --- portfolio bookkeeping: same math as src/tradingRobot.js, kept in-memory
// only (no data/portfolio.json writes) so a benchmark run never touches the
// live app's real paper-trading state. ---------------------------------------
export function createPortfolio(initialBalanceIdr) {
  return { balanceIdr: initialBalanceIdr, initialBalanceIdr, realizedProfitIdr: 0, positions: {}, transactions: [] };
}

export function openPosition(portfolio, { symbol, mode, entryPrice, stopPrice, targetPrice, maxHoldUntil, reason, time }, cfg) {
  if (portfolio.positions[symbol]) return null;
  if (Object.keys(portfolio.positions).length >= cfg.maxOpenPositions) return null;
  const spendIdr = Math.min(portfolio.balanceIdr * cfg.tradeAllocationPct, portfolio.balanceIdr);
  if (!(spendIdr > 0)) return null;
  const spendUsdt = spendIdr / cfg.usdIdrRate;
  const entryCostFactor = 1 - cfg.roundTripCostPct / 100 / 2;
  const quantity = (spendUsdt * entryCostFactor) / entryPrice;
  if (!(quantity > 0)) return null;
  portfolio.balanceIdr = round2(portfolio.balanceIdr - spendIdr);
  portfolio.positions[symbol] = { symbol, mode, quantity, entryPrice, stopPrice: stopPrice ?? null, targetPrice: targetPrice ?? null, maxHoldUntil: maxHoldUntil ?? null, investedIdr: spendIdr, openedAt: time, reason: reason || '' };
  const tx = { type: 'BUY', symbol, mode, quantity, price: entryPrice, spendIdr, reason: reason || '', time, balanceAfterIdr: portfolio.balanceIdr };
  portfolio.transactions.push(tx);
  return tx;
}

export function closePosition(portfolio, { symbol, exitPrice, reason, time }, cfg) {
  const position = portfolio.positions[symbol];
  if (!position) return null;
  const grossUsdt = position.quantity * exitPrice;
  const exitCostFactor = 1 - cfg.roundTripCostPct / 100 / 2;
  const netUsdt = grossUsdt * exitCostFactor;
  const netIdr = netUsdt * cfg.usdIdrRate;
  const realizedProfitIdr = round2(netIdr - position.investedIdr);
  portfolio.balanceIdr = round2(portfolio.balanceIdr + netIdr);
  portfolio.realizedProfitIdr = round2((portfolio.realizedProfitIdr || 0) + realizedProfitIdr);
  delete portfolio.positions[symbol];
  const tx = { type: 'SELL', symbol, mode: position.mode, quantity: position.quantity, price: exitPrice, entryPrice: position.entryPrice, proceedsIdr: round2(netIdr), realizedProfitIdr, reason: reason || '', time, openedAt: position.openedAt, holdMs: time - position.openedAt, balanceAfterIdr: portfolio.balanceIdr };
  portfolio.transactions.push(tx);
  return tx;
}

// --- the walk-forward simulation itself -------------------------------------
export async function runBacktest({
  symbols, months, minConfidencePct, riskRewardTemplate, endTime, baseUrl,
  // These used to come from config.js env vars; now DB-backed (settings.js),
  // so callers pass whatever's currently configured - defaults here are just
  // a safety net for ad-hoc/standalone use, matching the original env-var defaults.
  initialBalanceIdr = 10_000_000, tradeAllocationPct = 0.3, maxOpenPositions = 4, roundTripCostPct = 0.2, usdIdrRate = 16_800
}) {
  const rrMultiple = RR_TEMPLATES[riskRewardTemplate]?.ratio ?? RR_TEMPLATES.balanced.ratio;
  const windowEnd = endTime;
  const windowStart = windowEnd - months * 30 * 86_400_000;
  const cfg = { tradeAllocationPct, maxOpenPositions, roundTripCostPct, usdIdrRate };
  const portfolio = createPortfolio(initialBalanceIdr);

  const symbolState = {};
  for (const symbol of symbols) {
    console.log(`Fetching ${symbol} history (daily/1h/15m)...`);
    const history = await loadHistory(symbol, windowStart, windowEnd, baseUrl);
    console.log(`  got ${history.swing.length} daily / ${history.dayTrade.length} hourly / ${history.scalping.length} 15m candles`);
    // EMA50 (the slowest line any mode watches) needs 50 candles before it
    // produces a value at all - fewer than that (a newly-listed or illiquid
    // symbol) means evaluateEntry/evaluateExit stay stuck on "indicators
    // still warming up" for the WHOLE window: zero signals, a flat equity
    // curve, and no error, which otherwise looks identical to "nothing
    // happened to trade on." Flag it up front instead of leaving it silent.
    if (history.swing.length < 50 || history.dayTrade.length < 50 || history.scalping.length < 50) {
      console.warn(`  WARNING: ${symbol} doesn't have 50 candles on every timeframe yet (too new on Binance, or delisted/illiquid) - indicators may never mature, so this symbol can show zero signals for the whole window even though nothing is broken.`);
    }
    symbolState[symbol] = {
      history,
      cursors: { swing: makeCursor(history.swing, INTERVAL_SEC.swing), scalping: makeCursor(history.scalping, INTERVAL_SEC.scalping), dayTrade: makeCursor(history.dayTrade, INTERVAL_SEC.dayTrade) },
      signalsSeen: 0, signalsBlocked: 0,
      // Dedupe key for the "was there a fresh cross" check below - without
      // this, a swing (daily) signal that's blocked by confidence gets
      // re-evaluated and re-counted on every 15-minute tick until the next
      // daily candle closes (up to 96 times for one real event), which is
      // exactly what inflated an early run of this script to "594 signals
      // seen" for what was really a handful of distinct setups.
      lastEntryEvalKey: null,
      blockedSamples: []
    };
  }

  const equityCurve = [];
  let lastEquityDay = null;

  for (let t = windowStart; t <= windowEnd; t += TICK_MS) {
    const tSec = Math.floor(t / 1000);
    for (const symbol of symbols) {
      const st = symbolState[symbol];
      const swingSnap = st.cursors.swing(tSec);
      const scalpSnap = st.cursors.scalping(tSec);
      const dayTradeSnap = st.cursors.dayTrade(tSec);
      if (!swingSnap || !scalpSnap || !dayTradeSnap) continue; // still in warmup

      const modeSnaps = { swing: swingSnap, scalping: scalpSnap, dayTrade: dayTradeSnap };
      const recommendation = recommendMode({ swing: swingSnap, scalping: scalpSnap });
      const activeMode = recommendation.mode;

      const position = portfolio.positions[symbol];
      if (position) {
        // A coin keeps trading under the mode it was bought under - same rule as robotEngine.js.
        const heldSnap = modeSnaps[position.mode] || modeSnaps[activeMode];
        const exit = evaluateExit(heldSnap.candles, position, position.mode, { nowMs: t });
        if (exit.action === 'SELL') {
          closePosition(portfolio, { symbol, exitPrice: heldSnap.latest.close, reason: exit.reason, time: t }, cfg);
          st.lastEntryEvalKey = null; // force a fresh entry check once flat again, even on the same bar
        }
      } else {
        // A "fresh cross" is defined relative to the mode's own last two
        // candles, so as long as the active mode's latest candle hasn't
        // rolled over, re-running evaluateEntry produces the identical
        // result - only evaluate (and count) it once per distinct bar-close
        // per mode, not once per 15-minute simulation tick.
        const evalKey = `${activeMode}:${modeSnaps[activeMode].latest.time}`;
        if (st.lastEntryEvalKey !== evalKey) {
          st.lastEntryEvalKey = evalKey;
          const entry = evaluateEntry(modeSnaps[activeMode].candles, activeMode, { rrMultiple });
          if (entry.action === 'BUY') {
            st.signalsSeen += 1;
            if (entry.confidencePct >= minConfidencePct) {
              openPosition(portfolio, { symbol, mode: activeMode, entryPrice: entry.entryPrice, stopPrice: entry.stopPrice, targetPrice: entry.targetPrice, maxHoldUntil: entry.maxHoldUntil, reason: entry.reason, time: t }, cfg);
            } else {
              st.signalsBlocked += 1;
              if (st.blockedSamples.length < 8) {
                st.blockedSamples.push({ date: new Date(t).toISOString().slice(0, 10), mode: activeMode, confidencePct: entry.confidencePct });
              }
            }
          }
        }
      }
    }

    const dayKey = new Date(t).toISOString().slice(0, 10);
    if (dayKey !== lastEquityDay) {
      lastEquityDay = dayKey;
      let positionsValueIdr = 0;
      for (const [symbol, position] of Object.entries(portfolio.positions)) {
        const st = symbolState[symbol];
        const snap = st.cursors.scalping(tSec) || st.cursors.dayTrade(tSec) || st.cursors.swing(tSec);
        const price = snap?.latest?.close ?? position.entryPrice;
        positionsValueIdr += position.quantity * price * cfg.usdIdrRate;
      }
      equityCurve.push({ date: dayKey, equityIdr: round2(portfolio.balanceIdr + positionsValueIdr) });
    }
  }

  return { portfolio, equityCurve, symbolState, windowStart, windowEnd };
}

export function summarize({ portfolio, equityCurve, symbolState, windowStart, windowEnd, usdIdrRate = 16_800 }) {
  const sells = portfolio.transactions.filter((t) => t.type === 'SELL');
  const wins = sells.filter((t) => t.realizedProfitIdr > 0);
  const losses = sells.filter((t) => t.realizedProfitIdr <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.realizedProfitIdr, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedProfitIdr, 0));

  let peak = -Infinity, maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equityIdr);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equityIdr) / peak) * 100);
  }

  const tSec = Math.floor(windowEnd / 1000);
  let positionsValueIdr = 0;
  const openPositionsReport = [];
  for (const [symbol, position] of Object.entries(portfolio.positions)) {
    const st = symbolState[symbol];
    const snap = st.cursors.scalping(tSec) || st.cursors.dayTrade(tSec) || st.cursors.swing(tSec);
    const price = snap?.latest?.close ?? position.entryPrice;
    const marketValueIdr = position.quantity * price * usdIdrRate;
    positionsValueIdr += marketValueIdr;
    openPositionsReport.push({ symbol, mode: position.mode, entryPrice: position.entryPrice, currentPrice: price, unrealizedProfitIdr: round2(marketValueIdr - position.investedIdr) });
  }

  const finalEquityIdr = round2(portfolio.balanceIdr + positionsValueIdr);
  const totalReturnPct = round2(((finalEquityIdr - portfolio.initialBalanceIdr) / portfolio.initialBalanceIdr) * 100);

  return {
    windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(),
    initialBalanceIdr: portfolio.initialBalanceIdr, finalEquityIdr, totalReturnPct,
    cashIdr: portfolio.balanceIdr, realizedProfitIdr: portfolio.realizedProfitIdr,
    closedTrades: sells.length,
    winRate: sells.length ? round2((wins.length / sells.length) * 100) : null,
    avgWinIdr: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLossIdr: losses.length ? round2(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : null),
    maxDrawdownPct: round2(maxDrawdownPct),
    openPositions: openPositionsReport,
    signalsSeenTotal: Object.values(symbolState).reduce((s, st) => s + st.signalsSeen, 0),
    signalsBlockedByConfidence: Object.values(symbolState).reduce((s, st) => s + st.signalsBlocked, 0),
    // A few concrete blocked-signal examples (date/mode/confidence) per
    // symbol, so "0 trades" is checkable against real numbers instead of
    // just a count - see summary.json for the full list per symbol.
    blockedSignalSamples: Object.fromEntries(
      Object.entries(symbolState).filter(([, st]) => st.blockedSamples.length).map(([symbol, st]) => [symbol, st.blockedSamples])
    )
  };
}

function printSummary(summary, minConfidencePct, riskRewardTemplate) {
  console.log('\n===================================================================');
  console.log(' Benchmark result');
  console.log('===================================================================');
  console.log(`Window: ${summary.windowStart.slice(0, 10)} -> ${summary.windowEnd.slice(0, 10)}`);
  console.log(`Settings used: confidence threshold ${minConfidencePct}%, risk template "${riskRewardTemplate}"`);
  console.log(`Starting balance: Rp ${summary.initialBalanceIdr.toLocaleString('id-ID')}`);
  console.log(`Ending equity:    Rp ${Math.round(summary.finalEquityIdr).toLocaleString('id-ID')}  (${summary.totalReturnPct >= 0 ? '+' : ''}${summary.totalReturnPct}%)`);
  console.log(`Realized P&L:     Rp ${Math.round(summary.realizedProfitIdr).toLocaleString('id-ID')}`);
  console.log(`Closed trades: ${summary.closedTrades}  |  Win rate: ${summary.winRate ?? 'n/a'}%  |  Profit factor: ${summary.profitFactor ?? 'n/a'}`);
  console.log(`Avg win: Rp ${Math.round(summary.avgWinIdr).toLocaleString('id-ID')}  |  Avg loss: Rp ${Math.round(summary.avgLossIdr).toLocaleString('id-ID')}`);
  console.log(`Max drawdown: ${summary.maxDrawdownPct}%`);
  console.log(`BUY signals seen: ${summary.signalsSeenTotal}  |  blocked by confidence threshold: ${summary.signalsBlockedByConfidence}`);
  const blockedEntries = Object.entries(summary.blockedSignalSamples || {});
  if (blockedEntries.length) {
    console.log(`Sample blocked signals (date, mode, confidence vs. your ${minConfidencePct}% threshold):`);
    for (const [symbol, samples] of blockedEntries) {
      for (const s of samples) console.log(`  ${symbol}  ${s.date}  ${s.mode}  ${s.confidencePct}%`);
    }
  }
  if (summary.openPositions.length) {
    console.log(`Still open at window end (marked-to-market, not counted as closed trades):`);
    for (const p of summary.openPositions) {
      console.log(`  ${p.symbol} (${p.mode}): entry ${p.entryPrice}, now ${p.currentPrice}, unrealized Rp ${Math.round(p.unrealizedProfitIdr).toLocaleString('id-ID')}`);
    }
  }
  console.log('\nThis replays the exact same confidence-gated EMA-cross/RSI/ATR rules the live app');
  console.log('runs, against real historical prices - it is still a rule-based backtest, not a');
  console.log('guarantee of future results. See README "Honest results" for the same caveat that');
  console.log('applies to the original swing/scalping backtest this app was built on.');
}

async function writeReport(summary, portfolio, equityCurve) {
  const dir = path.join(config.rootDir, 'benchmarks', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const tradeRows = ['type,symbol,mode,time,price,quantity,realizedProfitIdr,reason']
    .concat(portfolio.transactions.map((t) => [t.type, t.symbol, t.mode, new Date(t.time).toISOString(), t.price, t.quantity, t.realizedProfitIdr ?? '', JSON.stringify(t.reason || '')].join(',')));
  await fs.writeFile(path.join(dir, 'trades.csv'), tradeRows.join('\n'));
  const equityRows = ['date,equityIdr'].concat(equityCurve.map((p) => `${p.date},${p.equityIdr}`));
  await fs.writeFile(path.join(dir, 'equity-curve.csv'), equityRows.join('\n'));
  console.log(`\nFull report written to ${dir}`);
  return dir;
}

export function parseArgs(argv) {
  const opts = { months: 3, minConfidencePct: undefined, riskRewardTemplate: undefined, symbols: undefined, endTime: Date.now() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--months') opts.months = Number(argv[++i]);
    else if (arg === '--min-confidence') opts.minConfidencePct = Number(argv[++i]);
    else if (arg === '--rr') opts.riskRewardTemplate = argv[++i];
    else if (arg === '--symbols') opts.symbols = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (arg === '--end') opts.endTime = new Date(argv[++i]).getTime();
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Settings are DB-backed now (see settings.js) - this degrades to hardcoded
  // defaults if the database isn't reachable rather than crashing, since this
  // is a standalone diagnostic script, not the live app itself.
  const settings = await readSettings().catch(() => null);
  const symbols = args.symbols || settings?.watchlist || ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
  const minConfidencePct = args.minConfidencePct ?? settings?.autoTrade?.minConfidencePct ?? 55;
  const riskRewardTemplate = args.riskRewardTemplate || settings?.autoTrade?.riskRewardTemplate || 'balanced';
  const initialBalanceIdr = settings?.initialBalanceIdr ?? 10_000_000;
  const usdIdrRate = settings?.usdIdrRate ?? 16_800;
  const binanceBaseUrl = settings?.binanceBaseUrl || 'https://data-api.binance.vision';

  console.log(`Benchmarking ${symbols.join(', ')} over ${args.months} month(s) ending ${new Date(args.endTime).toISOString().slice(0, 10)}`);
  console.log(`Starting balance: Rp ${initialBalanceIdr.toLocaleString('id-ID')}  |  confidence threshold ${minConfidencePct}%  |  RR template "${riskRewardTemplate}"\n`);

  const result = await runBacktest({
    symbols, months: args.months, minConfidencePct, riskRewardTemplate, endTime: args.endTime, baseUrl: binanceBaseUrl,
    initialBalanceIdr, usdIdrRate,
    tradeAllocationPct: settings?.tradeAllocationPct, maxOpenPositions: settings?.maxOpenPositions, roundTripCostPct: settings?.roundTripCostPct
  });
  const summary = summarize({ ...result, usdIdrRate });
  printSummary(summary, minConfidencePct, riskRewardTemplate);
  await writeReport(summary, result.portfolio, result.equityCurve);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error) => {
    console.error('\nBenchmark failed:', error.message);
    console.error('(This needs real internet access to Binance - run it on the machine where `npm start` runs, not inside a sandboxed session.)');
    process.exitCode = 1;
  });
}
