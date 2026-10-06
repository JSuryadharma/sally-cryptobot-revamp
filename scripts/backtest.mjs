// Walk-forward backtest of the v2 engine. It drives src/engine/core.js's
// advance() - the same function the live tick calls - over real Binance
// history, so what it reports is what the live engine would have done.
//
//   node scripts/backtest.mjs --months 12 --train 8
//
// Flags:
//   --months <n>     total window (default 12)
//   --train <n>      months used for parameter selection; the rest is the
//                    out-of-sample test (default 8). --train 0 skips the grid.
//   --symbols A,B    coins (default: liquid watchlist below)
//   --end <ISO>      window end (default: now)
//   --cost <pct>     round-trip cost % (default 0.2)
//   --slip <pct>     slippage % per fill (default 0.05)
//   --no-cache       refetch history instead of reusing benchmarks/.cache
//   --exits          also compare exit-rule variants (EXIT_VARIANTS) on the test window
//   --early          also compare early entry (5m and 15m checks) with close-only entry
//   --buy-early      run everything with "Buy early" (5m checks) switched on
//   --auto           also compare the autopilot (src/engine/autopilot.js),
//                    replayed day by day from the paper results known each day,
//                    with each breakout run on its own
//
// Output: console summary + benchmarks/v2-<timestamp>/{report.json,report.md,trades.csv}.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineCfg, TF_MS, ENGINE_TIMEFRAMES, BTC_SYMBOL } from '../src/engine/config.js';
import { advance, createEngineState } from '../src/engine/core.js';
import { createPortfolio, markToMarket } from '../src/engine/ledger.js';
import { fetchKlinesRange, WARMUP_BARS } from '../src/engine/candles.js';
import { enrichCandles } from '../src/indicators.js';
import { signalRecords, updateJournal, summarizeOutcomes } from '../src/engine/outcomes.js';
import { updatePaperJournal, summarizePaper, paperCostPct, paperResults } from '../src/engine/paperBreakout.js';
import { decideStrategy } from '../src/engine/autopilot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'TRXUSDT', 'APTUSDT', 'LTCUSDT', 'NEARUSDT', 'ATOMUSDT', 'INJUSDT', 'TONUSDT'];
const DEFAULT_BASE_URL = 'https://data-api.binance.vision';
const MONTH_MS = 30 * 86_400_000;
const USD_IDR = 16_800;
const INITIAL_IDR = 10_000_000;

// Only used with --train > 0. Kept small: every extra knob raises the odds of
// fitting noise.
export const GRID = {
  btcGate: [false, true],
  enableBreakout: [false, true]
};

// The exits before 2026-10-05 (breakeven at +1R, ATR trail, no target); the
// variants below start from them so their results stay comparable to PR #2.
const OLD_EXITS = { trailing: true, breakevenStop: true, targetR: null };

// Exit rules compared by --exits. Entries are unchanged, so differences come
// from the exits alone. partialAtR also sets where the stop moves to breakeven.
export const EXIT_VARIANTS = [
  { name: 'live default: stop-loss + fixed target +1.5R, no breakeven/trail', cfg: {} },
  { name: 'old: checks at 4h/daily close only', cfg: { ...OLD_EXITS, exitTf: null } },
  { name: 'old + fixed target +1.5R', cfg: { ...OLD_EXITS, exitTf: null, targetR: 1.5 } },
  { name: '5m checks (breakeven at +1R, ATR trail)', cfg: { ...OLD_EXITS, exitTf: '5m' } },
  { name: '5m + fixed target +1R', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 1 } },
  { name: '5m + fixed target +1.5R', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 1.5 } },
  { name: '5m + fixed target +2R', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 2 } },
  { name: '5m + fixed target +3R', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 3 } },
  { name: '5m + half at +1R, trail the rest', cfg: { ...OLD_EXITS, exitTf: '5m', partialFraction: 0.5 } },
  { name: '5m + half at +1R, rest at +2R', cfg: { ...OLD_EXITS, exitTf: '5m', partialFraction: 0.5, targetR: 2 } },
  { name: '5m + tight trail (half ATR mult)', cfg: { ...OLD_EXITS, exitTf: '5m', trailMult: 0.5 } },
  { name: '5m + +1.5R target, no time stop', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 1.5, timeStopMult: 100 } },
  { name: '5m + +2R target, no time stop', cfg: { ...OLD_EXITS, exitTf: '5m', targetR: 2, timeStopMult: 100 } },
  { name: '5m + breakeven at +0.75R, +1.5R target', cfg: { ...OLD_EXITS, exitTf: '5m', partialAtR: 0.75, targetR: 1.5 } }
];

export const CRITERIA = { minTrades: 60, minProfitFactor: 1.3, maxDrawdownPct: 12, maxSymbolProfitShare: 0.4 };

function parseArgs(argv) {
  // Default end = last UTC midnight, so repeated runs on the same day hit the history cache.
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const args = { months: 12, train: 0, symbols: DEFAULT_SYMBOLS, end, cost: 0.2, slip: 0.05, cache: true };
  for (let k = 0; k < argv.length; k += 1) {
    const flag = argv[k];
    const value = argv[k + 1];
    if (flag === '--months') { args.months = Number(value); k += 1; }
    else if (flag === '--train') { args.train = Number(value); k += 1; }
    else if (flag === '--symbols') { args.symbols = value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); k += 1; }
    else if (flag === '--end') { args.end = Date.parse(value); k += 1; }
    else if (flag === '--cost') { args.cost = Number(value); k += 1; }
    else if (flag === '--slip') { args.slip = Number(value); k += 1; }
    else if (flag === '--no-cache') args.cache = false;
    else if (flag === '--exits') args.exits = true;
    else if (flag === '--early') args.early = true;
    else if (flag === '--buy-early') args.buyEarly = true;
    else if (flag === '--auto') args.auto = true;
  }
  return args;
}

// Disk caching is a CLI-only convenience (see --no-cache) for re-running
// scripts/backtest.mjs locally without refetching Binance history every time.
// It must stay opt-in: the API route (src/backtestRunner.js) runs this on
// Vercel, whose deployed filesystem is read-only outside /tmp, so writing a
// cache file there fails every call.
async function loadRaw({ baseUrl, symbol, tf, startMs, endMs, useCache }) {
  if (!useCache) return fetchKlinesRange(baseUrl, symbol, tf, startMs, endMs);
  const cacheDir = path.join(ROOT, 'benchmarks', '.cache');
  const file = path.join(cacheDir, `${symbol}_${tf}_${startMs}_${endMs}.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* not cached yet */ }
  const raw = await fetchKlinesRange(baseUrl, symbol, tf, startMs, endMs);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw));
  return raw;
}

export async function loadSeries({ symbols, startMs, endMs, baseUrl = DEFAULT_BASE_URL, useCache = false, log = () => {} }) {
  const series = {};
  const all = [...new Set([...symbols, BTC_SYMBOL])];
  for (const symbol of all) {
    log(`  ${symbol}`);
    series[symbol] = {};
    for (const tf of ENGINE_TIMEFRAMES) {
      const raw = await loadRaw({ baseUrl, symbol, tf, startMs: startMs - WARMUP_BARS * TF_MS[tf], endMs, useCache });
      series[symbol][tf] = enrichCandles(raw);
    }
  }
  return series;
}

function lastCloseAt(bars, ms) {
  let lo = 0, hi = bars.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time * 1000 + TF_MS['15m'] <= ms) { found = bars[mid].close; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// The autopilot live: one decision per daily close from the paper trades
// closed by then, then the engine runs to that close with the chosen strategy.
// The paper test is replayed over all loaded history, so the first decision
// has about as much evidence as the live backfill (WARMUP_BARS days).
function advanceWithAutopilot(state, portfolio, series, { startMs, endMs, cfg, symbols, onGroup }) {
  const day = TF_MS['1d'];
  const journal = updatePaperJournal([], series, symbols, { window: { startMs: 0, endMs }, maxRecords: Infinity });
  const results = paperResults(journal, series, { costPct: paperCostPct(cfg) });
  const btcDaily = series[BTC_SYMBOL]['1d'];
  const out = { transactions: [], signals: [], riskEvents: [] };
  const decisions = [];
  let previous = null;
  for (let nowMs = Math.ceil(startMs / day) * day; ; nowMs = Math.min(nowMs + day, endMs)) {
    const decision = decideStrategy({ results, btcDaily, nowMs });
    if (!previous || previous.chosen !== decision.chosen || previous.paused !== decision.paused) {
      decisions.push({ date: new Date(nowMs).toISOString().slice(0, 10), chosen: decision.chosen, paused: decision.paused, why: decision.why });
    }
    previous = decision;
    const dayCfg = resolveEngineCfg({ ...cfg, profiles: decision.profiles, autopilotPause: decision.paused ? decision.pauseReason : null });
    const step = advance(state, portfolio, series, {
      nowMs, startMs, usdIdrRate: USD_IDR, cfg: dayCfg, tradeSymbols: symbols, onGroup, keepAllTransactions: true
    });
    out.transactions.push(...step.transactions);
    out.signals.push(...step.signals);
    out.riskEvents.push(...step.riskEvents);
    if (nowMs >= endMs) break;
  }
  return { ...out, decisions };
}

// Runs one simulation over [startMs, endMs) and returns metrics plus trades.
// autopilot: let autopilot.js pick the strategy each day instead of cfg.profiles.
export function simulate(series, { symbols, startMs, endMs, cfg, autopilot = false }) {
  const state = createEngineState();
  const portfolio = createPortfolio(INITIAL_IDR);
  const equityCurve = [];
  let lastDay = null;
  const onGroup = (closeMs, pf) => {
    const day = Math.floor(closeMs / 86_400_000);
    if (day === lastDay) return;
    lastDay = day;
    const prices = {};
    for (const symbol of Object.keys(pf.positions)) prices[symbol] = lastCloseAt(series[symbol]['15m'], closeMs);
    equityCurve.push({ date: new Date(closeMs).toISOString().slice(0, 10), equityIdr: markToMarket(pf, prices, USD_IDR).equityIdr });
  };
  const out = autopilot
    ? advanceWithAutopilot(state, portfolio, series, { startMs, endMs, cfg, symbols, onGroup })
    : advance(state, portfolio, series, {
      nowMs: endMs, startMs, usdIdrRate: USD_IDR, cfg, tradeSymbols: symbols, onGroup, keepAllTransactions: true
    });
  const prices = {};
  for (const symbol of Object.keys(portfolio.positions)) prices[symbol] = lastCloseAt(series[symbol]['15m'], endMs);
  const marked = markToMarket(portfolio, prices, USD_IDR);
  const finalEquityIdr = marked.equityIdr;
  equityCurve.push({ date: new Date(endMs).toISOString().slice(0, 10), equityIdr: finalEquityIdr });
  const metrics = computeMetrics({ transactions: out.transactions, equityCurve, finalEquityIdr, startMs, endMs, signals: out.signals });
  // Trend-following keeps its winners open, so closed-trade stats alone
  // understate a run that ends mid-trend. Report the open positions too.
  metrics.openAtEnd = Object.values(marked.positions).map((p) => ({
    symbol: p.symbol, profile: p.profile, openedAt: p.openedAt,
    unrealizedIdr: p.unrealizedProfitIdr ?? 0,
    unrealizedR: p.riskIdr > 0 ? Math.round(((p.unrealizedProfitIdr ?? 0) + (p.realizedSoFarIdr || 0)) / p.riskIdr * 100) / 100 : null
  }));
  const allR = [
    ...[...out.transactions].filter((t) => t.type === 'SELL' && !t.partial).map((t) => t.rMultiple),
    ...metrics.openAtEnd.map((p) => p.unrealizedR)
  ].filter(Number.isFinite);
  metrics.expectancyRInclOpen = allR.length ? Math.round((allR.reduce((s, v) => s + v, 0) / allR.length) * 100) / 100 : null;
  // Prediction accuracy: every signal, taken or skipped, followed to +1R/+2R or its stop.
  metrics.predictions = summarizeOutcomes(updateJournal([], signalRecords(out.signals, cfg), series, { maxRecords: Infinity }));
  // Paper-only daily breakout entry, replayed over the same window with the live tick's code.
  const paperJournal = updatePaperJournal([], series, symbols, { window: { startMs, endMs }, maxRecords: Infinity });
  metrics.paperBreakout = summarizePaper(paperJournal, { costPct: paperCostPct(cfg) });
  if (out.decisions) metrics.autopilotDecisions = out.decisions;
  return { metrics, transactions: out.transactions, equityCurve, riskEvents: out.riskEvents };
}

export function computeMetrics({ transactions, equityCurve, finalEquityIdr, startMs, endMs, signals = [] }) {
  const chronological = [...transactions].reverse();
  const finals = chronological.filter((t) => t.type === 'SELL' && !t.partial);
  const wins = finals.filter((t) => t.tradeRealizedIdr > 0);
  const losses = finals.filter((t) => t.tradeRealizedIdr <= 0);
  const grossWin = wins.reduce((s, t) => s + t.tradeRealizedIdr, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.tradeRealizedIdr, 0));
  const rs = finals.map((t) => t.rMultiple).filter(Number.isFinite);
  let peak = -Infinity, maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equityIdr);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equityIdr) / peak) * 100);
  }
  const bySymbol = {};
  const byProfile = {};
  const exitKinds = {};
  for (const t of finals) {
    (bySymbol[t.symbol] ||= { trades: 0, pnlIdr: 0 });
    bySymbol[t.symbol].trades += 1;
    bySymbol[t.symbol].pnlIdr += t.tradeRealizedIdr;
    (byProfile[t.profile] ||= { trades: 0, pnlIdr: 0, wins: 0 });
    byProfile[t.profile].trades += 1;
    byProfile[t.profile].pnlIdr += t.tradeRealizedIdr;
    if (t.tradeRealizedIdr > 0) byProfile[t.profile].wins += 1;
    exitKinds[t.exitKind] = (exitKinds[t.exitKind] || 0) + 1;
  }
  const positivePnl = Object.values(bySymbol).reduce((s, v) => s + Math.max(0, v.pnlIdr), 0);
  const maxSymbolProfitShare = positivePnl > 0 ? Math.max(...Object.values(bySymbol).map((v) => Math.max(0, v.pnlIdr))) / positivePnl : 0;
  const holdHours = finals.map((t) => (Date.parse(t.createdAt) - Date.parse(t.openedAt)) / 3_600_000).filter(Number.isFinite);
  const r2 = (v) => Math.round(v * 100) / 100;
  const netIdr = finalEquityIdr - INITIAL_IDR;
  return {
    windowStart: new Date(startMs).toISOString(), windowEnd: new Date(endMs).toISOString(),
    initialBalanceIdr: INITIAL_IDR, finalEquityIdr: r2(finalEquityIdr),
    totalReturnPct: r2((netIdr / INITIAL_IDR) * 100),
    closedTrades: finals.length,
    winRate: finals.length ? r2((wins.length / finals.length) * 100) : null,
    avgWinIdr: wins.length ? r2(grossWin / wins.length) : 0,
    avgLossIdr: losses.length ? r2(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : (grossWin > 0 ? 999 : null),
    expectancyR: rs.length ? r2(rs.reduce((s, v) => s + v, 0) / rs.length) : null,
    maxDrawdownPct: r2(maxDrawdownPct),
    maxSymbolProfitShare: r2(maxSymbolProfitShare),
    avgHoldHours: holdHours.length ? r2(holdHours.reduce((s, v) => s + v, 0) / holdHours.length) : null,
    partialsTaken: chronological.filter((t) => t.partial).length,
    byProfile: Object.fromEntries(Object.entries(byProfile).map(([k, v]) => [k, { trades: v.trades, winRate: r2((v.wins / v.trades) * 100), pnlIdr: r2(v.pnlIdr) }])),
    bySymbol: Object.fromEntries(Object.entries(bySymbol).sort((a, b) => b[1].pnlIdr - a[1].pnlIdr).map(([k, v]) => [k, { trades: v.trades, pnlIdr: r2(v.pnlIdr) }])),
    exitKinds,
    signalsSkipped: signals.filter((s) => !s.taken).length
  };
}

export function checkCriteria(metrics, stressMetrics) {
  const checks = [
    { name: `>= ${CRITERIA.minTrades} trades`, ok: metrics.closedTrades >= CRITERIA.minTrades, value: metrics.closedTrades },
    { name: `profit factor >= ${CRITERIA.minProfitFactor}`, ok: (metrics.profitFactor ?? 0) >= CRITERIA.minProfitFactor, value: metrics.profitFactor },
    { name: 'positive expectancy (R)', ok: (metrics.expectancyR ?? -1) > 0, value: metrics.expectancyR },
    { name: 'positive expectancy at 0.3% cost', ok: (stressMetrics?.expectancyR ?? -1) > 0, value: stressMetrics?.expectancyR ?? null },
    { name: `max drawdown <= ${CRITERIA.maxDrawdownPct}%`, ok: metrics.maxDrawdownPct <= CRITERIA.maxDrawdownPct, value: metrics.maxDrawdownPct },
    { name: `no symbol > ${CRITERIA.maxSymbolProfitShare * 100}% of profit`, ok: metrics.maxSymbolProfitShare <= CRITERIA.maxSymbolProfitShare, value: metrics.maxSymbolProfitShare }
  ];
  return { passed: checks.every((c) => c.ok), checks };
}

function gridCombos() {
  let combos = [{}];
  for (const [key, values] of Object.entries(GRID)) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  return combos;
}

// Rewards expectancy and sample size together; tiny samples can't win.
function objective(m) {
  if (m.closedTrades < 30 || m.expectancyR == null) return -Infinity;
  return m.expectancyR * Math.sqrt(m.closedTrades);
}

// Used by src/backtestRunner.js for the in-app "Run backtest" button: a single
// run with the given engine settings over the last `months`.
export async function runBacktest({ symbols, months = 1, endTime = Date.now(), baseUrl = DEFAULT_BASE_URL, engineCfg = {} }) {
  const startMs = endTime - months * MONTH_MS;
  const series = await loadSeries({ symbols, startMs, endMs: endTime, baseUrl });
  const cfg = resolveEngineCfg(engineCfg);
  return simulate(series, { symbols, startMs, endMs: endTime, cfg });
}

function tradesCsv(transactions) {
  const header = 'createdAt,type,symbol,profile,setup,price,quantity,partial,exitKind,realizedProfitIdr,tradeRealizedIdr,rMultiple,confidencePct,reason';
  const rows = [...transactions].reverse().map((t) => [
    t.createdAt, t.type, t.symbol, t.profile, t.setup, t.price, t.quantity, t.partial ?? '', t.exitKind ?? '',
    t.realizedProfitIdr ?? '', t.tradeRealizedIdr ?? '', t.rMultiple ?? '', t.confidencePct ?? '', `"${String(t.reason || '').replaceAll('"', "'")}"`
  ].join(','));
  return [header, ...rows].join('\n');
}

function fmtMetrics(m) {
  const open = m.openAtEnd?.length ? `, ${m.openAtEnd.length} open (exp incl. open ${m.expectancyRInclOpen}R)` : '';
  return `trades ${m.closedTrades}, win ${m.winRate ?? '-'}%, PF ${m.profitFactor ?? '-'}, exp ${m.expectancyR ?? '-'}R, return ${m.totalReturnPct}%, maxDD ${m.maxDrawdownPct}%${open}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startMs = args.end - args.months * MONTH_MS;
  const splitMs = args.train > 0 ? startMs + args.train * MONTH_MS : startMs;
  const baseCfg = { roundTripCostPct: args.cost, slippagePct: args.slip, ...(args.buyEarly ? { earlyEntry: true } : {}) };
  console.log(`Loading ${args.symbols.length} symbols, ${args.months} months (${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(args.end).toISOString().slice(0, 10)})...`);
  const series = await loadSeries({ symbols: args.symbols, startMs, endMs: args.end, useCache: args.cache, log: (m) => console.log(m) });

  const report = { generatedAt: new Date().toISOString(), args: { ...args, end: new Date(args.end).toISOString() }, criteria: CRITERIA };
  let chosen = {};
  if (args.train > 0) {
    console.log(`\nGrid search on the train window (${args.train} months, ${gridCombos().length} combinations)...`);
    const results = [];
    for (const combo of gridCombos()) {
      const { metrics } = simulate(series, { symbols: args.symbols, startMs, endMs: splitMs, cfg: resolveEngineCfg({ ...baseCfg, ...combo }) });
      results.push({ combo, metrics: { closedTrades: metrics.closedTrades, winRate: metrics.winRate, profitFactor: metrics.profitFactor, expectancyR: metrics.expectancyR, totalReturnPct: metrics.totalReturnPct, maxDrawdownPct: metrics.maxDrawdownPct }, score: objective(metrics) });
      process.stdout.write('.');
    }
    results.sort((a, b) => b.score - a.score);
    chosen = results[0].score > -Infinity ? results[0].combo : {};
    report.grid = results;
    console.log(`\nBest on train: ${JSON.stringify(chosen)} -> ${fmtMetrics(results[0].metrics)}`);
  }

  const testCfg = resolveEngineCfg({ ...baseCfg, ...chosen });
  const test = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: testCfg });
  const stress = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg({ ...baseCfg, ...chosen, roundTripCostPct: 0.3 }) });
  const defaults = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg(baseCfg) });
  const verdict = checkCriteria(test.metrics, stress.metrics);
  Object.assign(report, { chosenParams: chosen, test: test.metrics, stress: stress.metrics, defaultsOnTest: defaults.metrics, verdict });

  console.log(`\nOut-of-sample (${new Date(splitMs).toISOString().slice(0, 10)} -> ${new Date(args.end).toISOString().slice(0, 10)}):`);
  console.log(`  chosen params: ${fmtMetrics(test.metrics)}`);
  console.log(`  0.3% cost:     ${fmtMetrics(stress.metrics)}`);
  console.log(`  defaults:      ${fmtMetrics(defaults.metrics)}`);
  console.log(`  by profile: ${JSON.stringify(test.metrics.byProfile)}`);
  console.log(`  exits: ${JSON.stringify(test.metrics.exitKinds)}`);
  const pred = test.metrics.predictions;
  const one = pred.levels['1R'];
  console.log(`\nPrediction accuracy (${pred.signals} signals, ${pred.taken} taken, ${pred.pending} undecided):`);
  for (const [level, l] of Object.entries(pred.levels)) {
    console.log(`  +${level} before stop: ${l.overall.hitRatePct ?? '-'}% of ${l.overall.decided} (taken ${l.taken.hitRatePct ?? '-'}%, skipped ${l.skipped.hitRatePct ?? '-'}%), score AUC ${l.scoreAucPct ?? '-'}`);
  }
  console.log(`  +1R by score: ${one.byScore.filter((b) => b.decided).map((b) => `${b.bucket}: ${b.hitRatePct}% (${b.decided})`).join(', ')}`);
  console.log(`\nPaper test, daily breakouts when BTC > 200-day average (${test.metrics.paperBreakout.costPct}% cost charged in R):`);
  for (const r of test.metrics.paperBreakout.rules) {
    console.log(`  ${r.label}, +${r.targetR}R target: ${r.closed} closed, win ${r.winPct ?? '-'}%, avg ${r.avgR ?? '-'}R, total ${r.totalR}R, ${r.open} open`);
  }
  console.log(`\nCriteria: ${verdict.passed ? 'PASSED' : 'FAILED'}`);
  for (const c of verdict.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (${c.value})`);

  if (args.exits) {
    console.log('\nExit rules on the same entries (0.2% / 0.3% cost):');
    report.exitVariants = EXIT_VARIANTS.map((v) => {
      const base = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg({ ...baseCfg, ...chosen, ...v.cfg }) }).metrics;
      const costly = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg({ ...baseCfg, ...chosen, ...v.cfg, roundTripCostPct: 0.3 }) }).metrics;
      const verdictV = checkCriteria(base, costly);
      console.log(`  ${v.name.padEnd(42)} ${fmtMetrics(base)}, hold ${base.avgHoldHours}h | 0.3%: exp ${costly.expectancyR ?? '-'}R | criteria ${verdictV.passed ? 'PASSED' : `failed ${verdictV.checks.filter((c) => !c.ok).length}`}`);
      console.log(`  ${''.padEnd(42)} exits ${JSON.stringify(base.exitKinds)}`);
      return { ...v, metrics: base, stressExpectancyR: costly.expectancyR, verdict: verdictV };
    });
  }

  if (args.early) {
    console.log('\nEntry timing on the test window (0.2% / 0.3% cost):');
    const timings = [{ earlyEntry: false }, { earlyEntry: true, earlyTf: '15m' }, { earlyEntry: true, earlyTf: '5m' }];
    report.entryTiming = timings.map((timing) => {
      const { earlyEntry } = timing;
      const name = earlyEntry ? `early (${timing.earlyTf} checks)` : 'candle close only';
      const base = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg({ ...baseCfg, ...chosen, ...timing }) }).metrics;
      const costly = simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, cfg: resolveEngineCfg({ ...baseCfg, ...chosen, ...timing, roundTripCostPct: 0.3 }) }).metrics;
      console.log(`  ${name.padEnd(20)} ${fmtMetrics(base)} | 0.3%: exp ${costly.expectancyR ?? '-'}R, return ${costly.totalReturnPct}%`);
      return { name, ...timing, metrics: base, stressExpectancyR: costly.expectancyR };
    });
  }

  if (args.auto) {
    console.log('\nAutopilot vs each breakout alone, test window (0.2% / 0.3% cost):');
    const runs = [
      { name: '20-day breakout only', cfg: { profiles: { breakout: true, breakout55: false } } },
      { name: '55-day breakout only', cfg: { profiles: { breakout: false, breakout55: true } } },
      { name: 'both breakouts on', cfg: { profiles: { breakout: true, breakout55: true } } },
      { name: 'autopilot', cfg: {}, autopilot: true }
    ];
    report.autopilot = runs.map((run) => {
      const sim = (extra) => simulate(series, { symbols: args.symbols, startMs: splitMs, endMs: args.end, autopilot: run.autopilot, cfg: resolveEngineCfg({ ...baseCfg, ...run.cfg, ...extra }) }).metrics;
      const base = sim({});
      const costly = sim({ roundTripCostPct: 0.3 });
      const verdictA = checkCriteria(base, costly);
      console.log(`  ${run.name.padEnd(22)} ${fmtMetrics(base)} | 0.3%: exp ${costly.expectancyR ?? '-'}R, return ${costly.totalReturnPct}% | criteria ${verdictA.passed ? 'PASSED' : `failed ${verdictA.checks.filter((c) => !c.ok).length}`}`);
      if (base.autopilotDecisions) {
        for (const d of base.autopilotDecisions) console.log(`    ${d.date}: ${d.paused ? 'paused' : d.chosen} (${d.why})`);
      }
      return { name: run.name, metrics: base, stressExpectancyR: costly.expectancyR, stressReturnPct: costly.totalReturnPct, verdict: verdictA };
    });
  }

  const outDir = path.join(ROOT, 'benchmarks', `v2-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, 'trades.csv'), tradesCsv(test.transactions));
  await fs.writeFile(path.join(outDir, 'equity.csv'), ['date,equityIdr', ...test.equityCurve.map((p) => `${p.date},${p.equityIdr}`)].join('\n'));
  console.log(`\nReport written to ${path.relative(ROOT, outDir)}/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
