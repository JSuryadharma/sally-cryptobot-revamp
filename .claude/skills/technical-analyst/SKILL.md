---
name: technical-analyst
description: This skill should be used when analyzing weekly price charts for cryptocurrencies (or, incidentally, other instruments). Use this skill when the user provides chart images and requests technical analysis, trend identification, support/resistance levels, scenario planning, or probability assessments based purely on chart data without consideration of news or fundamental factors. Complements robocrypto's own automated EMA-cross/RSI/ATR strategy (src/decisionEngine.js) with a manual, discretionary weekly read.
---

# Technical Analyst

Rewritten for robocrypto from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)'s `technical-analyst` (originally a Python/equity-oriented skill). This version keeps the asset-agnostic chart-reading workflow and drops the original's "Contrarian Confirmation Mode" (a COT-crowding/futures-to-ETF pipeline specific to equities and futures positioning data that has no crypto equivalent robocrypto tracks).

## Overview

This skill enables comprehensive technical analysis of weekly price charts. Analyze chart images to identify trends, support and resistance levels, moving average relationships, volume patterns, and develop probabilistic scenarios for future price movement. All analysis is conducted objectively using only chart data, without influence from news, fundamentals, or market sentiment.

**Relationship to robocrypto's own strategy**: `src/decisionEngine.js` trades a fast, mechanical EMA-cross on daily/hourly/15m candles with zero discretion (see the `backtest-expert` skill for how that gets validated). This skill is the opposite kind of tool - a slower, discretionary, human-in-the-loop *weekly* read, useful for context the bot's own indicators don't carry (support/resistance zones, multi-week pattern structure, scenario probability). It never feeds back into `evaluateEntry`/`evaluateExit` automatically - it's for the person watching the process, not for the auto-trader.

## When to Use

- User provides weekly chart images (crypto, or any instrument) and requests technical analysis
- Need to identify trend direction, strength, and potential reversal points
- Looking for support/resistance levels and key price zones
- Want probabilistic scenario planning with specific price targets
- Want a manual weekly cross-check alongside a `scripts/benchmark.mjs` result or a live BTCUSDT/ETHUSDT/etc. position

## Prerequisites

- **Chart Images**: user must provide weekly timeframe chart images for analysis
- **No API Keys / No network**: this skill analyzes user-provided images; no external data fetches

## Output

Markdown analysis reports saved to `reports/`:
- **File format**: `[SYMBOL]_technical_analysis_[YYYY-MM-DD].md`
- **Content**: comprehensive analysis including trend, S/R levels, MA analysis, volume, patterns, and 2-4 probabilistic scenarios with targets and invalidation levels

## Core Principles

1. **Pure Chart Analysis**: base all conclusions exclusively on technical data visible in the chart
2. **Systematic Approach**: follow a structured methodology for each chart analysis
3. **Objective Assessment**: avoid subjective bias; focus on observable patterns and data
4. **Probabilistic Scenarios**: express future possibilities as probability-weighted scenarios
5. **Sequential Processing**: analyze each chart individually and document findings immediately

## Analysis Workflow

### Step 1: Receive Chart Images

Confirm receipt of all chart images, identify how many are to be analyzed, note any specific focus areas requested, then proceed sequentially, one at a time.

### Step 2: Load Technical Analysis Framework

```
Read: references/technical_analysis_framework.md
```

Trend analysis and classification, support/resistance identification, moving average interpretation, volume analysis, chart patterns and candlestick analysis, scenario development and probability assignment, analysis discipline and objectivity.

### Step 3: Analyze Each Chart Systematically

#### 3.1 Trend Analysis
- Direction (uptrend, downtrend, sideways), strength (strong, moderate, weak), duration, exhaustion signals
- Higher highs/lows or lower highs/lows pattern

#### 3.2 Support and Resistance Analysis
- Significant horizontal support/resistance, trendline S/R, role reversals, confluence zones

#### 3.3 Moving Average Analysis

robocrypto's own strategy code (`src/decisionEngine.js` `STRATEGY_PARAMS`, `src/indicators.js` `enrichCandles`) already computes EMA9/12/20/21/26/50 and SMA20/50 on every candle - use the SAME lines on the weekly chart so this manual read is directly comparable to what the bot is watching on its own timeframes, instead of inventing an unrelated 200-week-MA convention:

- Price vs EMA20, EMA50 (the two lines robocrypto's own `swing` mode watches for its cross)
- MA alignment (bullish/bearish/neutral), slope (rising/falling/flat)
- Any recent or pending EMA20/EMA50 crossover (the same event `evaluateEntry`'s `swing` mode fires a BUY signal on daily candles - a weekly read one level up in timeframe gives you the bigger-picture context around that same cross)
- MAs acting as dynamic support or resistance

#### 3.4 Volume Analysis
- Overall volume trend, spikes and their context, confirmation/divergence with price, climax/exhaustion patterns

#### 3.5 Chart Patterns and Price Action
- Reversal patterns (hammers, shooting stars, engulfing), continuation patterns (flags, triangles), notable candlestick formations, recent breakouts/breakdowns

#### 3.6 Synthesize Observations
- Integrate all elements into a coherent current assessment; note conflicting signals; establish key levels that will determine future direction

### Step 4: Develop Probabilistic Scenarios

2-4 distinct scenarios per chart, each with:
1. **Scenario Name**
2. **Probability Estimate** (must sum to 100% across all scenarios)
3. **Description**
4. **Supporting Factors** (minimum 2-3, technical only)
5. **Target Levels**
6. **Invalidation Level**

Typical framework: Base Case (40-60%), Bull Case (20-40%), Bear Case (20-40%), Alternative (5-15%). Adjust based on strength of supporting factors; ensure probabilities are realistic and sum to 100%.

### Step 5: Generate Analysis Report

```
Read and use as template: assets/analysis_template.md
```

Save each analysis as `[SYMBOL]_technical_analysis_[YYYY-MM-DD].md` (e.g. `BTC_technical_analysis_2026-09-05.md`) in `reports/`.

### Step 6: Repeat for Multiple Charts

Complete Steps 3-5 fully for one chart, save it, then move to the next. Do not batch analyses.

## Quality Standards

### Objectivity Requirements
- Base all analysis strictly on observable chart data
- Avoid incorporating external information (news, fundamentals, sentiment)
- Do not use subjective language like "I think" or "I feel"
- Express uncertainty clearly when signals are ambiguous
- Present both bullish and bearish possibilities to avoid confirmation bias

### Completeness Requirements
- Address all sections of the analysis template
- Provide specific price levels for support, resistance, and targets
- Justify probability estimates with technical factors
- Include invalidation levels for each scenario

### Clarity Requirements
- Use precise technical terminology correctly
- Structure information logically
- Include specific price levels, not vague descriptions
- Make scenarios distinct and mutually exclusive

## Example Usage

**Single chart**: user provides a BTC weekly chart -> confirm receipt -> read the framework reference -> systematic analysis (trend, S/R, MA, volume, patterns) -> 3 scenarios with probabilities -> report -> save as `BTC_technical_analysis_2026-09-05.md`.

**Multiple charts**: user provides BTC, ETH, SOL weekly charts -> analyze and save each completely (one at a time) before moving to the next -> notify user when all are complete.

**Focused request**: user asks specifically about a resistance breakout -> full systematic analysis, with extra attention to volume/trend-strength factors bearing on breakout probability.

## Resources

### references/technical_analysis_framework.md
Comprehensive methodology: trend criteria, S/R identification, MA interpretation, volume principles, chart pattern recognition, scenario/probability framework, objectivity reminders. Read before conducting analysis.

### assets/analysis_template.md
Structured template for every analysis report - copy the format, populate with specific findings per chart.

## Disclaimer

This analysis is based purely on technical chart data and does not consider fundamental factors, news, or market sentiment. It represents a probabilistic assessment of potential scenarios, not a prediction or investment/trading recommendation - consistent with this project's own "Honest results" stance (see README). All probabilities are estimates based on technical factors and subject to change as new data emerges.
