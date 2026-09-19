---
name: crypto-regime-analyzer
description: Quantifies crypto market regime health using free, keyless public data (CoinGecko + Binance). Generates a 0-100 composite score across 6 components (100 = risk-on) with a posture recommendation for robocrypto's watchlist. Use when the user asks about crypto market conditions, whether it's alt season, BTC dominance, crypto risk-on vs risk-off, funding rates, or whether robocrypto's auto-trader should be watched more closely before it opens new positions.
---

# Crypto Regime Analyzer Skill

Rewritten for robocrypto from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)'s `crypto-regime-analyzer` (originally Python). This port is a single Node.js script with no extra dependency - it runs with the same `node` this project already uses for `scripts/benchmark.mjs`, and reuses `src/config.js`'s `binanceBaseUrl` (`data-api.binance.vision`) so it isn't geo-blocked the way `api.binance.com`/`fapi.binance.com` are on some networks.

## Purpose

Quantify the crypto market regime using a data-driven 6-component scoring system (0-100). It answers "what posture does the broad crypto market currently support?" **before** looking at any single coin - a macro overlay that sits alongside `src/aiAdvisor.js`'s `recommendMode()`, which picks swing/scalp/day-trade for one coin at a time. This skill never picks coins or overrides that per-coin logic; it describes the environment those decisions are being made in.

**Score direction:** 100 = maximum risk-on health (broad participation, healthy trend, sane leverage), 0 = critical risk-off.

**No API key required** - CoinGecko's free public API and Binance's public endpoints only.

## When to Use This Skill

- User asks "Is crypto risk-on or risk-off right now?" or "How healthy is the crypto market?"
- User asks "Is it alt season?" or about BTC dominance direction
- User asks whether funding rates are overheated (crowded leverage, liquidation-cascade risk)
- User wants a market-wide sanity check before trusting `scripts/benchmark.mjs` results or robocrypto's live auto-trade signals for a given day
- User wants to know whether the current calm/chaos in robocrypto's paper-trading balance reflects the strategy or just broad market conditions

## What This Skill Does NOT Do

- No coin picks, no buy/sell signals, no price targets
- No execution or portfolio changes - regime description only, same "process over promises" stance as the rest of robocrypto (see README "Honest results")
- Does not change `data/settings.json`, `data/portfolio.json`, or anything the live app reads/writes - fully separate from robocrypto's own state, same isolation principle as `scripts/benchmark.mjs`

## Prerequisites

- **Node.js** (already required to run robocrypto)
- **Internet access** to `api.coingecko.com` and, best-effort, `fapi.binance.com` (BTC daily history comes from `data-api.binance.vision` instead, matching `scripts/benchmark.mjs`)
- **No API keys required**

## Component Model

| # | Component | Weight | Question it answers |
|---|---|---|---|
| 1 | BTC Trend Structure | 25% | Is the reserve asset's primary trend intact? (price vs 50/200DMA stack, 200DMA slope) |
| 2 | Alt Breadth Participation | 20% | How broadly are alts participating? (% of top-N above 200DMA, 50DMA confirmation) |
| 3 | BTC Dominance Regime | 15% | Where is capital rotating? (dominance direction interpreted jointly with BTC trend) |
| 4 | Perpetual Funding Regime | 15% | How crowded is leverage? (avg funding across majors; contrarian at extremes) |
| 5 | Drawdown & Volatility Position | 15% | Where are we in the cycle? (drawdown from 1y high, realized vol percentile) |
| 6 | Momentum Thrust / Washout | 10% | Short-horizon confirmation (% of universe positive over 30d) |

Missing components have their weight proportionally redistributed, but only when at least 4 of 6 components (>= 65% of total model weight) are available - sparser input reports `zone: UNKNOWN` rather than a false-precision score.

### Regime Zones

| Score | Zone | Posture |
|---|---|---|
| 80-100 | RISK_ON | Broad risk-on conditions observed; review risk limits before decisions |
| 40-79 | NEUTRAL | Mixed conditions observed; no strong regime conclusion |
| 0-39 | RISK_OFF | Defensive market conditions observed; review existing risk controls |

These are heuristic descriptive bands ported from the original skill, not validated allocation rules - same caveat this project already applies to its own strategy backtests (README "Honest results").

---

## Execution Workflow

### Phase 1: Run the Analysis Script

```bash
node .claude/skills/crypto-regime-analyzer/scripts/crypto_regime_analyzer.mjs \
  --output-dir reports/crypto-regime
```

First run of the day is slow (~2-4 minutes at the default `--top-n 20`, CoinGecko's free tier throttles to a handful of requests/minute); same-day re-runs hit the per-UTC-day cache in `.crypto_regime_cache/` and are instant. Options: `--top-n <int>` (default 20), `--cache-dir <path>` (default `.crypto_regime_cache`), `--input-json <path>` (offline snapshot, no network - same schema `data_client.py` validated in the original), `--quiet`.

### Phase 2: Interpret the Output

The script writes `crypto_regime.json` (machine-readable) and `crypto_regime.md` (one-page report) to `--output-dir`, and prints a one-line summary:

```
CRYPTO REGIME: NEUTRAL (score 65/100) - Mixed conditions observed; no strong regime conclusion
```

Lead with the zone and posture, then explain the 1-2 components most responsible using their `signal` strings. Flag any component reporting `data_available: false` and what that means for confidence in the composite.

### Phase 3 (optional): Cross-Check Against robocrypto's Own Signals

If the user is asking "why didn't the bot trade" or "why is the benchmark all losses," a `RISK_OFF` or heavily-degraded regime reading is useful supporting context - but it must never be used to override or second-guess a specific `evaluateEntry`/`evaluateExit` result from `src/decisionEngine.js`. That logic is confidence-gated and tested on its own terms (see `scripts/mockAutotradeTest.mjs`); this skill only adds "and here's what the wider market was doing at the time."

## Output

- `crypto_regime.json` - full machine-readable analysis: `metadata`, per-component results (`score`, `signal`, `data_available`, component-specific fields), and the `composite` block (`score`, `zone`, `guidance`, `effective_weights`).
- `crypto_regime.md` - one-page report: composite score + zone, posture line, per-component table (weight / score / signal).
- Console: `CRYPTO REGIME: <ZONE> (score <N>/100) - <posture>` plus a line for any skipped component.

## Resources

- `scripts/crypto_regime_analyzer.mjs` - the full analyzer: CoinGecko/Binance data client with per-UTC-day cache, all 6 calculators, the weighted-composite scorer, CLI, and Markdown/JSON report writers. Ported 1:1 (same thresholds, same weights) from the original Python `data_client.py` + `scripts/calculators/*.py` + `scorer.py` + `crypto_regime_analyzer.py`, collapsed into one file to match this project's single-script style (`scripts/benchmark.mjs`).
- `references/crypto_regime_methodology.md` - full scoring rationale, every threshold table, and the offline snapshot JSON schema for `--input-json`.

## Known Limitations

- **Dominance history accumulates locally**, one observation per run-day in `--cache-dir`. The dominance component reports `data_available: false` until 31 daily observations exist (its weight is redistributed until then) - this is expected on a fresh install, not a bug. Seed it faster via `--input-json` if you have a source for historical BTC dominance.
- **Funding is best-effort.** `fapi.binance.com` has no `data-api.binance.vision`-style geo-unblocked mirror, so if it's unreachable (this project's own network hit exactly this during testing) the component is skipped gracefully and its weight redistributed - same documented behavior as the original.
- **Universe is top-N by market cap** (CoinGecko), independent of robocrypto's own 5-coin watchlist in `data/settings.json` - this is deliberate, so "alt breadth" reflects the broader market rather than just the coins robocrypto happens to be trading.
- Thresholds are heuristic defaults carried over from the original skill, not backtested optima - same honesty standard this project already holds itself to (see README "Honest results").

## Disclaimer

Educational and process-improvement use only. This skill describes market conditions; it does not provide financial advice, signals, or buy/sell instructions. All decisions remain the user's responsibility.
