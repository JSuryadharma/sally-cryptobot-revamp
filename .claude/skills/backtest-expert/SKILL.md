---
name: backtest-expert
description: Expert guidance for systematic backtesting of trading strategies, adapted for robocrypto. Use when developing, testing, stress-testing, or validating robocrypto's own EMA-cross/RSI/ATR strategies, or the parameter sweeps run against scripts/benchmark.mjs. Covers "beating ideas to death" methodology, parameter robustness testing, slippage modeling, bias prevention, and interpreting backtest results. Applicable when the user asks about backtesting, strategy validation, robustness testing, avoiding overfitting, or evaluating a scripts/benchmark.mjs report.
---

# Backtest Expert

Systematic approach to backtesting trading strategies, rewritten for robocrypto from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)'s `backtest-expert` (originally Python). The methodology is asset-agnostic and carries over unchanged; the evaluation script is now a Node.js port (`evaluate_backtest.mjs`, no extra dependency) with one addition: it can read a `scripts/benchmark.mjs` report directly via `--summary`, instead of requiring every metric typed out by hand.

## Core Philosophy

**Goal**: Find strategies that "break the least", not strategies that "profit the most" on paper.

**Principle**: Add friction, stress test assumptions, and see what survives. If a strategy holds up under pessimistic conditions, it's more likely to work in live trading.

This is exactly the standard this project already holds itself to - see README "Honest results" and `src/decisionEngine.js`'s own top-of-file comment ("every one of these three systems came out net-negative over the last year once realistic costs were included. They are shipped anyway...").

## When to Use This Skill

- Evaluating a `scripts/benchmark.mjs` run - is 55 closed trades over 3 months actually enough to trust a -3% or +3% result?
- Sweeping robocrypto's own knobs (confidence threshold, RR template `conservative`/`balanced`/`aggressive`) and wanting an honest Deploy/Refine/Abandon read instead of eyeballing a table
- Troubleshooting why a backtest result might be misleading (curve-fitting, short window, tiny sample)
- Learning proper backtesting methodology before proposing a change to `src/decisionEngine.js`'s entry/exit rules
- Setting realistic expectations before treating any `benchmarks/<timestamp>/summary.json` number as meaningful

## Prerequisites

- **Node.js** (already required to run robocrypto)
- No API keys, no external data - metrics are user-provided or read from a local `summary.json`

## Workflow

### 1. State the Hypothesis

Define the edge in one sentence. If you can't articulate it clearly, don't proceed to testing. For robocrypto's shipped strategies, the hypothesis is already stated in `src/decisionEngine.js`'s `STRATEGY_PARAMS` comments (EMA-cross + RSI confirmation + ATR-sized stop/target, one set of parameters per mode).

### 2. Codify Rules with Zero Discretion

Already true here by construction: `evaluateEntry`/`evaluateExit` in `src/decisionEngine.js` are the actual live rules, not a description of them - `scripts/benchmark.mjs` replays those exact functions, so there's no gap between "the strategy as tested" and "the strategy as traded."

### 3. Run Initial Backtest

```bash
node scripts/benchmark.mjs --months 3 --symbols BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT
```

Examine the printed summary for basic viability (closed trades > 0, win rate, profit factor). **Minimum 5 years is the general standard** (see Step 4) - robocrypto's Binance history realistically caps out well short of that for many alts, so treat any single `--months` window as a lower-confidence read, not a verdict, and say so plainly when reporting results.

### 4. Stress Test the Strategy

This is where 80% of testing time should be spent.

**Parameter sensitivity**: sweep `--min-confidence` and `--rr` across a grid (e.g. 40/45/50/55/60/65% x conservative/balanced/aggressive) rather than trusting one setting. Look for **plateaus of stable performance, not narrow spikes** - a result that only looks good at exactly one confidence threshold is a red flag, not a discovery.

**Execution friction**: robocrypto already bakes `roundTripCostPct` (DB-backed, see settings.js) into every trade unconditionally (`openPosition`/`closePosition` in `scripts/benchmark.mjs`), so cost is never zero - but it's a single fixed assumption, not stress-tested at 1.5-2x. If you want to check sensitivity to it, temporarily raise `ROUND_TRIP_COST_PCT` and re-run rather than trusting the default as a worst case.

**Time robustness**: run the same sweep across multiple `--months` windows (e.g. 3 and 6) and multiple `--end` dates. Require the read to hold up across windows, not just the most recent one.

**Sample size**: absolute minimum 30 closed trades, preferred 100+, high confidence 200+. A `summary.json` with `closedTrades: 2` is not evidence of anything either way.

### 5. Out-of-Sample Validation

Walk-forward analysis (optimize on one window, validate on the next, roll forward) is the gold standard but needs far more history than a 3-6 month crypto window realistically provides here. Flag this limitation explicitly rather than pretending a single-window sweep is out-of-sample validation.

### 6. Evaluate Results

Use the evaluation script for a structured, quantitative Deploy/Refine/Abandon read:

```bash
node .claude/skills/backtest-expert/scripts/evaluate_backtest.mjs \
  --summary benchmarks/<timestamp>/summary.json \
  --num-parameters 2 \
  --output-dir reports/
```

`--num-parameters` should count the knobs actually swept to reach the reported result (robocrypto's own: confidence threshold + RR template = 2 by default). `avg-win-pct`/`avg-loss-pct` are auto-derived from `summary.json`'s IDR figures via the DB-backed `tradeAllocationPct` setting as an approximation (position size drifts trade to trade, so this is directional, not exact) - pass `--avg-win-pct`/`--avg-loss-pct` explicitly to override. Or supply every metric by hand, matching the original CLI:

```bash
node .claude/skills/backtest-expert/scripts/evaluate_backtest.mjs \
  --total-trades 150 --win-rate 62 --avg-win-pct 1.8 --avg-loss-pct 1.2 \
  --max-drawdown-pct 15 --years-tested 8 --num-parameters 3 --slippage-tested \
  --output-dir reports/
```

The script scores across 5 dimensions (Sample Size, Expectancy, Risk Management, Robustness, Execution Realism), detects red flags, and outputs a Deploy/Refine/Abandon verdict.

## Key Testing Principles

### Punish the Strategy

Add friction everywhere - commissions higher than reality, worse-than-typical slippage, worst-case fills. Strategies that survive pessimistic assumptions often outperform in live trading.

### Seek Plateaus, Not Peaks

**Good**: profitable across a *range* of confidence thresholds. **Bad**: only works at exactly one setting. This session's own confidence-threshold sweep across 40-65% and conservative/balanced/aggressive found all 36 combinations net-negative on real BTC/ETH/BNB/SOL/XRP data - a flat, honest result, not a narrow spike hunted into existence.

### Test All Cases, Not Cherry-Picked Examples

Run every symbol on the watchlist, every window, not just the one that happened to look good. `scripts/benchmark.mjs --symbols` accepts a comma list for exactly this.

### Separate Idea Generation from Validation

Intuition is useful for generating hypotheses about what to change in `src/decisionEngine.js`; validation must be purely the numbers `scripts/benchmark.mjs` and this evaluation script produce. Never let attachment to an idea (or a prior session's effort) influence interpretation of a red or flat result.

## Common Failure Patterns

1. **Parameter sensitivity**: only works with one exact confidence threshold or RR template
2. **Regime-specific**: great in one 3-month window, terrible in the next
3. **Slippage sensitivity**: unprofitable once `roundTripCostPct` is raised
4. **Small sample**: too few closed trades for statistical confidence (< 30)
5. **Look-ahead bias**: `scripts/benchmark.mjs`'s `makeCursor()` already guards against this (a candle only counts as known once its close time has passed) - if a result looks "too good," check that guard hasn't been bypassed by a code change, not that the strategy is secretly brilliant
6. **Over-optimization**: sweeping many knobs until one combination turns green - see `references/failed_tests.md`

## Output

- `reports/backtest_eval_<timestamp>.json` - structured evaluation with per-dimension scores, red flags, and verdict
- `reports/backtest_eval_<timestamp>.md` - human-readable report with dimension table, key metrics, and red flag details

## Resources

### Methodology Reference
**File**: `references/methodology.md` - stress testing methods, parameter sensitivity analysis, slippage/friction modeling, sample size requirements, market regime classification, common biases (survivorship, look-ahead, curve-fitting).

### Failed Tests Reference
**File**: `references/failed_tests.md` - why failures are valuable, common failure patterns with examples, a red-flags checklist. Read this when a strategy fails tests, or before trusting a result that looks unusually good.

### Evaluation Script
**File**: `scripts/evaluate_backtest.mjs` - the 5-dimension scorer, ported 1:1 from the original `evaluate_backtest.py` (verified identical output on the same manual inputs during this rewrite), plus `--summary` to read a robocrypto benchmark report directly.

## Critical Reminders

**Time allocation**: spend 20% generating ideas, 80% trying to break them.

**Red flag**: results that look too good (>90% win rate, minimal drawdowns) - audit for look-ahead bias before celebrating. Given `src/decisionEngine.js`'s own documented historical net-negative finding, a sudden "green" result on a small sample is far more likely a bug or an overfit sweep than a real edge - see the corresponding red flag (`too_good`) the script raises automatically.

**Statistical significance**: small edges need large sample sizes to prove. A 5% edge per trade needs 100+ trades to distinguish from luck - robocrypto's typical 3-6 month window on 5 symbols rarely reaches that on its own.

## Discretionary vs Systematic Differences

This skill focuses on **systematic/quantitative** backtesting, which is what robocrypto already is by construction - `evaluateEntry`/`evaluateExit` contain zero discretion, and `scripts/benchmark.mjs` tests every historical bar, not cherry-picked examples.
