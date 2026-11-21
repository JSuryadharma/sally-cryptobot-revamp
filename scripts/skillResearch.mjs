// Day-trader-skill setups vs the robot's breakout, on daily candles.
//
//   node scripts/skillResearch.mjs --market crypto --months 36
//   node scripts/skillResearch.mjs --market idx --months 36
//
// Each setup from the skill's scanner (src/tools/scanner.js) is traded the
// same simple way as scripts/entryResearch.mjs: buy at the signal close, stop
// first within a bar, then the target, then a time exit; no overlapping
// trades per symbol; costs charged in R. Train/test split in time.
//
// Rules compared:
// - robot: 55-day and 20-day high breakout, regime filter, 3-ATR stop (the
//   live crypto rule at its close; live buys a 5m break, so it fills earlier).
// - skill setups: breakout20 (closing high), bullFlag, reclaimMa20,
//   oversoldBounce, oversold, and "2+ setups" (confluence), each with and
//   without the regime filter, with a 2-ATR stop or a swing-low stop.
// Regime filter = BTC (crypto) or IHSG (idx) above its 200-day average.
//
// Output: console summary + reports/skill-research-<market>-<date>.md and .json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsi } from '../src/indicators.js';
import { BTC_SYMBOL } from '../src/engine/config.js';
import { loadRaw, DEFAULT_SYMBOLS } from './backtest.mjs';
import { fetchIdxDaily, DEFAULT_IDX_WATCHLIST, IDX_REGIME_SYMBOL } from '../src/markets/idx.js';
import { tradeOutcome, stats } from './entryResearch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const MONTH_MS = 30 * DAY;
const WARMUP_DAYS = 260;
export const TARGETS_R = [1, 1.5, 2, 3];

// ---------- features (index k uses bars <= k only, full precision) ----------
function rolling(values, n, fn) {
  return values.map((_, k) => (k + 1 < n ? null : fn(values.slice(k - n + 1, k + 1))));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function features(bars) {
  const c = bars.map((b) => b.close);
  const sma20 = rolling(c, 20, mean);
  const sma200 = rolling(c, 200, mean);
  const r14 = rsi(c, 14);
  const tr = bars.map((b, k) => (k === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[k - 1]), Math.abs(b.low - c[k - 1]))));
  const atr = new Array(bars.length).fill(null);
  for (let k = 14; k < bars.length; k += 1) atr[k] = k === 14 ? mean(tr.slice(1, 15)) : (atr[k - 1] * 13 + tr[k]) / 14;
  const priorMax = (arr, n) => arr.map((_, k) => (k < n ? null : Math.max(...arr.slice(k - n, k))));
  return {
    c, sma20, sma200, r14, atr,
    closeHigh20: priorMax(c, 20),
    high20: priorMax(bars.map((b) => b.high), 20),
    high55: priorMax(bars.map((b) => b.high), 55),
    low5: bars.map((_, k) => (k < 4 ? null : Math.min(...bars.slice(k - 4, k + 1).map((b) => b.low))))
  };
}

// The skill's daily setups at bar k (same tests as src/tools/scanner.js).
export function setupsAt(f, k) {
  const { c } = f;
  if (k < 30) return [];
  const out = [];
  if (f.closeHigh20[k] != null && c[k] > f.closeHigh20[k]) out.push('breakout20');
  const last5 = c.slice(k - 4, k + 1);
  if (c[k - 5] / c[k - 15] - 1 > 0.10 && (Math.max(...last5) - Math.min(...last5)) / c[k] < 0.05) out.push('bullFlag');
  if (f.sma20[k - 1] != null && c[k - 1] < f.sma20[k - 1] && c[k] > f.sma20[k]) out.push('reclaimMa20');
  if (f.r14[k] != null && f.r14[k] < 30) out.push('oversold');
  if (f.r14[k - 1] != null && f.r14[k - 1] < 30 && c[k] > c[k - 1]) out.push('oversoldBounce');
  return out;
}

// ---------- rules ----------
const atrStop = (mult) => (f, k) => (f.atr[k] > 0 ? { entry: f.c[k], stop: f.c[k] - mult * f.atr[k] } : null);
// Swing-low stop: below the 5-day low, at least 0.5 ATR and at most 3 ATR away.
const swingStop = (f, k) => {
  if (!(f.atr[k] > 0) || f.low5[k] == null) return null;
  const dist = Math.min(3 * f.atr[k], Math.max(0.5 * f.atr[k], f.c[k] - (f.low5[k] - 0.1 * f.atr[k])));
  return { entry: f.c[k], stop: f.c[k] - dist };
};

function buildRules() {
  const rules = [
    { name: 'ROBOT 55-day breakout + regime, 3 ATR', group: 'robot', maxBars: 30, regime: true, when: (f, k, bars) => f.high55[k] != null && bars[k].close > f.high55[k], plan: atrStop(3) },
    { name: 'ROBOT 20-day breakout + regime, 3 ATR', group: 'robot', maxBars: 30, regime: true, when: (f, k, bars) => f.high20[k] != null && bars[k].close > f.high20[k], plan: atrStop(3) }
  ];
  const setups = ['breakout20', 'bullFlag', 'reclaimMa20', 'oversoldBounce', 'oversold', 'confluence2'];
  for (const s of setups) {
    for (const regime of [false, true]) {
      for (const [stopName, plan] of [['2 ATR', atrStop(2)], ['swing low', swingStop]]) {
        rules.push({
          name: `skill ${s}${regime ? ' + regime' : ''}, ${stopName}`, group: 'skill', setup: s, maxBars: 15, regime, plan,
          when: (f, k) => { const hits = setupsAt(f, k); return s === 'confluence2' ? hits.length >= 2 : hits.includes(s); }
        });
      }
    }
  }
  return rules;
}

function regimeOn(regime, closeTime) {
  // Latest regime bar closed at or before closeTime.
  let lo = 0, hi = regime.bars.length - 1, j = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (regime.bars[mid].closeTime <= closeTime) { j = mid; lo = mid + 1; } else hi = mid - 1; }
  return j >= 0 && regime.f.sma200[j] != null && regime.bars[j].close > regime.f.sma200[j];
}

export function runResearch(data, { symbols, regimeSymbol, startMs, endMs, splitMs, costPct }) {
  const regime = { bars: data[regimeSymbol], f: features(data[regimeSymbol]) };
  const feats = Object.fromEntries(symbols.filter((s) => data[s]).map((s) => [s, features(data[s])]));
  return buildRules().map((rule) => {
    const rows = TARGETS_R.map((targetR) => {
      const trades = [];
      for (const s of Object.keys(feats)) {
        const bars = data[s];
        const f = feats[s];
        let busy = -1;
        for (let k = 30; k < bars.length; k += 1) {
          const t = bars[k].closeTime;
          if (t < startMs || t >= endMs || k <= busy) continue;
          if (rule.regime && !regimeOn(regime, t)) continue;
          if (!rule.when(f, k, bars)) continue;
          const plan = rule.plan(f, k);
          if (!plan) continue;
          const o = tradeOutcome(bars, k, plan, { targetR, maxBars: rule.maxBars, costPct });
          if (!o) continue;
          busy = o.exitIndex;
          trades.push({ s, t, r: o.r });
        }
      }
      return {
        targetR,
        all: stats(trades.map((x) => x.r)),
        train: stats(trades.filter((x) => x.t < splitMs).map((x) => x.r)),
        test: stats(trades.filter((x) => x.t >= splitMs).map((x) => x.r))
      };
    });
    return { rule: rule.name, group: rule.group, rows };
  });
}

// ---------- data ----------
async function loadCrypto(symbols, startMs, endMs) {
  const data = {};
  for (const s of new Set([...symbols, BTC_SYMBOL])) {
    const raw = await loadRaw({ baseUrl: 'https://data-api.binance.vision', symbol: s, tf: '1d', startMs: startMs - WARMUP_DAYS * DAY, endMs, useCache: true });
    data[s] = raw.map((b) => ({ ...b, closeTime: b.time * 1000 + DAY })).filter((b) => b.closeTime <= endMs);
    process.stderr.write(`${s} ${data[s].length} days\n`);
  }
  return data;
}
async function loadIdx(symbols, months) {
  const data = {};
  const years = Math.ceil(months / 12) + 1;
  for (const s of [...symbols, IDX_REGIME_SYMBOL]) {
    try {
      const { candles } = await fetchIdxDaily(s, { range: `${years}y` });
      data[s] = candles.map((b) => ({ ...b, closeTime: b.closeTime ?? (b.time * 1000 + DAY) }));
      process.stderr.write(`${s} ${candles.length} days\n`);
    } catch (e) { process.stderr.write(`${s} failed: ${e.message}\n`); }
  }
  return data;
}

function parseArgs(argv) {
  const a = { market: 'crypto', months: 36, split: 0.6, cost: null, end: Math.floor(Date.now() / DAY) * DAY };
  for (let k = 0; k < argv.length; k += 1) {
    const v = argv[k + 1];
    if (argv[k] === '--market') { a.market = v; k += 1; }
    else if (argv[k] === '--months') { a.months = Number(v); k += 1; }
    else if (argv[k] === '--split') { a.split = Number(v); k += 1; }
    else if (argv[k] === '--cost') { a.cost = Number(v); k += 1; }
    else if (argv[k] === '--end') { a.end = Date.parse(v); k += 1; }
  }
  a.cost ??= a.market === 'idx' ? 0.4 : 0.3;
  return a;
}

const cell = (s) => (s.n ? `${s.n} · ${s.winPct}% · ${s.avgR}R · PF ${s.pf ?? '-'}` : '-');

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const startMs = a.end - a.months * MONTH_MS;
  const splitMs = startMs + a.split * (a.end - startMs);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const symbols = a.market === 'idx' ? DEFAULT_IDX_WATCHLIST : DEFAULT_SYMBOLS;
  const regimeSymbol = a.market === 'idx' ? IDX_REGIME_SYMBOL : BTC_SYMBOL;
  const data = a.market === 'idx' ? await loadIdx(symbols, a.months) : await loadCrypto(symbols, startMs, a.end);
  if (!data[regimeSymbol]?.length) throw new Error(`No ${regimeSymbol} history`);
  const results = runResearch(data, { symbols, regimeSymbol, startMs, endMs: a.end, splitMs, costPct: a.cost });

  // Best target per rule, chosen on TRAIN only (avg R), then reported on test.
  const best = results.map((r) => {
    const pick = r.rows.filter((x) => x.train.n >= 15).sort((x, y) => y.train.avgR - x.train.avgR)[0] || r.rows[0];
    return { rule: r.rule, group: r.group, targetR: pick.targetR, all: pick.all, train: pick.train, test: pick.test };
  }).sort((x, y) => (y.test.avgR ?? -9) - (x.test.avgR ?? -9));

  const lines = [
    `# Skill setups vs robot breakout (${a.market})`, '',
    `${symbols.length} ${a.market === 'idx' ? 'stocks' : 'coins'}, ${day(startMs)} to ${day(a.end)}. Train to ${day(splitMs)}, test after. Cost ${a.cost}% round trip, charged in R.`,
    'Target per rule picked on train (best avg R), then shown on test. Cells: trades · win rate · avg R per trade · profit factor.', '',
    '| Rule | Target | Train | Test | All |', '|---|---|---|---|---|',
    ...best.map((b) => `| ${b.rule} | +${b.targetR}R | ${cell(b.train)} | ${cell(b.test)} | ${cell(b.all)} |`), '',
    '## Every target', ''
  ];
  for (const r of results) {
    lines.push(`**${r.rule}**`, '', '| Target | Train | Test |', '|---|---|---|');
    for (const x of r.rows) lines.push(`| +${x.targetR}R | ${cell(x.train)} | ${cell(x.test)} |`);
    lines.push('');
  }
  await fs.mkdir(path.join(ROOT, 'reports'), { recursive: true });
  const base = path.join(ROOT, 'reports', `skill-research-${a.market}-${day(a.end)}`);
  await fs.writeFile(`${base}.md`, lines.join('\n'));
  await fs.writeFile(`${base}.json`, JSON.stringify({ args: { ...a, end: day(a.end) }, splitAt: day(splitMs), best, results }, null, 2));
  console.log(lines.slice(0, best.length + 8).join('\n'));
  console.log(`\nWritten ${path.relative(ROOT, base)}.md/.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
