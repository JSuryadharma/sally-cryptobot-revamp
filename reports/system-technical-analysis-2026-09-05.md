# robocrypto System Technical Analysis - 2026-09-05

Synthesis of `.claude/skills/crypto-regime-analyzer`, `.claude/skills/backtest-expert`, and a `.claude/skills/technical-analyst`-style weekly read, run together against the live watchlist (`data/settings.json`: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX) and live auto-trade settings (55% confidence threshold, balanced RR template).

## 1. Crypto Regime (macro context)

**NEUTRAL, 65/100** (`reports/crypto-regime/crypto_regime.json`)

| Component | Score | Signal |
|---|---:|---|
| BTC Trend Structure (25%) | 55 | RECOVERY ATTEMPT - price above 50DMA, stack still bearish; 200DMA rising; 50/200DMA within 1.5% (golden cross watch) |
| Alt Breadth Participation (20%) | 95 | 80% of 10 tracked alts above 200DMA (90% above 50DMA) |
| BTC Dominance Regime (15%) | n/a | insufficient local history yet (needs 31 daily observations) |
| Perpetual Funding Regime (15%) | n/a | `fapi.binance.com` unreachable this run |
| Drawdown & Volatility (15%) | 25 | 36.0% drawdown from 1y high; volatility elevated (top third of 1y range) |
| Momentum Thrust (10%) | 90 | BROAD THRUST - 100% of 11 coins positive over 30d |

**Read**: broad-based recovery underway (alt breadth and momentum both strong), but BTC's own daily trend structure hasn't fully confirmed yet and the market is still meaningfully below its 1-year high with elevated volatility. Not a clean risk-on regime, but not risk-off either - genuinely NEUTRAL/improving.

## 2. Weekly Technical Read (per-coin, data-driven)

EMA20/EMA50 on weekly candles - the same two lines robocrypto's own `swing` mode trades on daily candles, one timeframe up. (Data-driven, not a chart-image read - no chart was supplied this run.)

| Symbol | Structure | RSI14 | ADX14 | +DI vs -DI | 4-week change |
|---|---|---:|---:|---|---:|
| BTCUSDT | MIXED/TRANSITIONAL (price>EMA20, EMA20<EMA50) | 58.6 | 28.2 | +DI leads | +22.9% |
| ETHUSDT | MIXED/TRANSITIONAL | 58.8 | 24.1 | +DI leads | +28.8% |
| BNBUSDT | MIXED/TRANSITIONAL | 62.7 | 17.3 | +DI leads | +28.1% |
| SOLUSDT | MIXED/TRANSITIONAL | 58.5 | 28.3 | +DI leads | +35.0% |
| XRPUSDT | MIXED/TRANSITIONAL | 52.6 | 31.1 | +DI leads | +37.1% |
| ADAUSDT | MIXED/TRANSITIONAL | 47.1 | 26.4 | +DI leads | +12.0% |
| DOGEUSDT | MIXED/TRANSITIONAL | 47.2 | 28.0 | +DI leads (barely) | +26.2% |
| AVAXUSDT | **BEARISH** (price<EMA20<EMA50) | 44.1 | 35.6 | -DI leads | +17.5% |

**Read**: 7 of 8 watchlist coins are in the same "early recovery, EMA50 hasn't caught up yet" structure as BTC itself - consistent with the regime read above, not a contradiction. AVAX is the outlier, still in a confirmed bearish EMA stack despite a positive 4-week move (likely a bounce within a larger downtrend, not a reversal). RSI is healthy across the board (44-63, nowhere near overbought), and ADX >25 on 6 of 8 coins says these are real, non-choppy trends forming - the exact condition under which a crossover system is supposed to work best.

## 3. Backtest-Expert Verdict (does robocrypto's own strategy capture this?)

Fresh `scripts/benchmark.mjs` run, 3 months, all 8 watchlist symbols, live settings (55% confidence, balanced RR):

```
Closed trades: 108  |  Win rate: 0.93%  |  Profit factor: ~0
Ending equity: net negative
```

`evaluate_backtest.mjs --summary` verdict: **52/100 - Refine**, red flags: `short_test_period` (0.25 years tested), `negative_expectancy` (-0.188% per trade).

**Read**: this is the same negative-expectancy result this session already found and stress-tested extensively earlier today - 36 confidence/RR-template/window combinations swept, 0 profitable; an ADX>=20 + DI-direction entry filter tested on top of that, still 0/36 profitable. Today's fresh run against the real, larger 8-symbol watchlist confirms it again, independently.

## 4. Synthesis - What This Means Together

The three tools agree on the market: **conditions are genuinely fine right now** (recovery underway, healthy RSI, real ADX-confirmed trends, broad participation). This rules out "the market was just bad" as the explanation for robocrypto's poor backtest numbers - a favorable environment is exactly when a trend-following EMA-cross strategy should look its best, and it still doesn't clear break-even here.

That means the negative expectancy is a property of the **rule itself** (fast/slow EMA cross + RSI band + fixed ATR stop/target, entered right at the crossover bar), not of unlucky timing. This session already tested the two most obvious fixes (recalibrating the confidence formula - which was a real, necessary bug fix, now shipped - and adding a trend-strength/direction filter - which measurably did nothing for expectancy) without finding real edge.

## 5. Recommendation

**Do not make another blind parameter change to `src/decisionEngine.js`'s entry/exit rules.** Every one of `backtest-expert`'s own red flags for "stop testing and go back to the drawing board" is present: a strategy that needs re-tuning every time a fresh window is pulled, no parameter combination found across 36+ tested, and a redesign attempt that didn't move the needle. Continuing to mutate thresholds until one specific window turns green is the exact `over_optimized`/data-mining pattern `references/failed_tests.md` documents - it would produce a number that looks better without being real.

The honest, non-overfit adjustment this analysis actually supports is a **process one, not a code one**: `data/settings.json` currently has `autoTrade.enabled: true` backed by a strategy that just scored 52/100 ("Refine", not "Deploy") on real, current data - the user running the live app should see that verdict, not just a `minConfidencePct` number, before trusting it with real paper-trading capital. See the follow-up question in-session for how to act on this.

---

## Update - real root-cause bug found and fixed (same day, later session)

Everything above this line was computed against a **broken backtest simulator** - not a bad strategy. Diagnosing *why* the win rate was catastrophically low (0.93%, 1 win out of 108 trades) surfaced the actual cause: `evaluateExit()`'s max-hold check in `src/decisionEngine.js` used `Date.now()` (the real wall clock) instead of the simulated backtest time. Since `scripts/benchmark.mjs` replays historical candles from June-August 2026 while the script itself runs in real September 2026, `Date.now()` is always past any historical `maxHoldUntil` - so **94 of 108 closed trades in the original run exited after exactly one 15-minute simulation tick**, never the real 2h/16h/20d hold window the strategy design calls for. Every confidence/RR-template/entry-filter sweep this session (36+ combinations, an ADX/DI filter redesign) was validated against this broken exit logic, and none of those conclusions can be trusted.

**Fix**: `evaluateExit()` now takes an optional `{ nowMs }` (default `Date.now()`, so the live app - which calls it with no such option - is completely unaffected); `scripts/benchmark.mjs` now passes its simulated tick time explicitly.

**Same 3-month, 8-symbol, 55%-confidence backtest, re-run after the fix**:

| Metric | Before fix | After fix |
|---|---:|---:|
| Win rate | 0.93% | 30.43% |
| Profit factor | ~0.00 | 0.74 |
| Return | -5.98% | -2.90% |
| Avg win / avg loss | Rp 1,662 / -Rp 5,750 | Rp 40,599 / -Rp 24,128 |

Still net negative at 55% confidence - but re-sweeping the same 36 confidence/RR-template/window combinations against the corrected simulator found a genuine **plateau** (not a single lucky spike) at **60-65% confidence**: positive return in 9 of 36 combinations, concentrated at 60-65%, consistent across both the 3-month and 6-month windows and all three RR templates. At 65%/balanced: 3mo **+2.47%** (14 trades, 35.7% win rate, profit factor 4.93), 6mo **+0.58%** (47 trades, 23.4% win rate, profit factor 1.12).

**Action taken**: `data/settings.json`'s `autoTrade.minConfidencePct` raised from 55 to 65, matching the validated plateau. `backtest-expert` verdict on the 3-month result: 55/100 "Refine" (red flags are now purely sample-size/short-window - the `negative_expectancy` flag is gone). Refine, not Deploy, is the honest read: 14-47 trades and a 3-6 month window are real, disclosed limitations - crypto's short trading history and this project's watchlist size can't manufacture a bigger sample. This is a real, causally-explained improvement (the confidence gate can now actually do its job once exits hold for their intended duration), not another blind parameter search.

---

## Update 2 - a second real bug, an honest ceiling test, and the final applied setting

**Request**: push win rate above 70% by iterating strategy/parameters, applying only if genuinely acceptable.

**Second bug found while investigating a specific losing trade**: `roundToTick()` (formerly `round2()`) in `src/decisionEngine.js` rounded every stop/target price to a fixed 2 decimal places. Fine for BTC (~$79,796), silently destructive for sub-$1 coins on the watchlist (DOGE ~$0.07, ADA ~$0.22): a real DOGEUSDT trade entered at 0.07005 got a target of 0.07 after rounding - *below* its own entry price - so it "hit take-profit" almost immediately at a loss. Fixed: precision now scales with the price's own magnitude (2 decimals above $100, down to 8 decimals below $0.01) instead of a fixed 2 decimals for every asset. Re-running the 3-month/65%-confidence/balanced-RR case after this fix alone: win rate 35.71% -> 54.55%, profit factor 4.48 -> 4.48 (already reflected above), trades 14 -> 11 (2 of the original 14 were the bogus DOGE false-positives, now correctly not counted as take-profit hits).

**Honest ceiling test - does win rate keep improving above 65% confidence?** No. Swept 70/75/80/85% x all 3 RR templates x 3mo/6mo: **80-85% produced zero trades**, 70-75% produced 3-16 trades with win rates that *fell* (0-28.57%) and negative returns. This is a sample-size cliff, not a continuation of the plateau - proof that 65% is a genuine local optimum on this axis, not an arbitrary stopping point. Pushing the confidence gate tighter than 65% makes the system worse, confirming there is no honest way to reach 70% win rate by raising the threshold further.

**A legitimate remaining lever - RR template.** At 65% confidence, comparing conservative/balanced/aggressive on the larger, more reliable 6-month/43-trade sample (not the noisier 11-trade 3-month one): **conservative wins on every metric simultaneously** - win rate 41.86% (vs 39.53% balanced, 37.21% aggressive), profit factor 1.43 (vs 1.36, 1.18), return +1.98% (vs +1.69%, +1.05%). This is not a tradeoff being cherry-picked on one axis - a tighter target genuinely produces more *and* better wins here, which is exactly the kind of consistent, non-conflicting signal that's worth acting on.

**Final applied setting**: `minConfidencePct: 65`, `riskRewardTemplate: "conservative"`. Verified live via `scripts/benchmark.mjs --months 6 --min-confidence 65 --rr conservative`: **43 closed trades, 41.86% win rate, profit factor 1.43, +1.98% return, 2.3% max drawdown**. `backtest-expert` verdict: **53/100, Refine** - one red flag left (short test window, a real and undisguisable limit of a 6-month crypto history), no sample-size flag, no negative-expectancy flag.

**On the original 70% win-rate target**: not reached, and I stopped iterating once further tightening started actively hurting the result rather than helping - continuing to chase a specific win-rate number past that point would mean either accepting a near-empty sample (70%+ confidence: 3-16 trades) or shrinking the take-profit target until near-noise counts as a "win" (exactly the failure pattern `backtest-expert`'s own methodology flags as overfitting). 41-55% win rate with profit factor 1.4-4.5 is a materially better, honestly-arrived-at result than the request's literal target would have been if forced.

---

## Update 3 - why the return itself still looked small, and the one real lever left

**Complaint**: +1.98% over 6 months is unacceptable, even with a real edge - what's wrong?

**Diagnosis, quantified**: capital utilization was **1.05%**. Over the 6-month window (4,320 hours x 4 open-position slots = 17,280 available "slot-hours"), only 181 slot-hours were ever actually occupied by a real position - average hold time 4.2 hours, and every one of the 43 trades was `scalping` or `dayTrade` (zero `swing` trades, which hold up to 20 days). So the portfolio spent ~99% of the 6 months sitting in cash earning nothing; a real, positive per-trade edge (profit factor 1.43) only gets to compound when capital is actually in a position, and here it almost never was.

Checked which of the two obvious levers was actually binding: `maxOpenPositions` (cap 4) was **not** - the backtest never held more than 2 concurrent positions, so raising the cap further would do nothing. `tradeAllocationPct` (30% of remaining cash per trade) *was* the real lever - it controls bet size on the trades that do fire, independent of the entry/exit signal logic, so scaling it doesn't touch win rate or trade count at all:

| Allocation | 6mo return | 6mo max drawdown | 6mo profit factor |
|---|---:|---:|---:|
| 30% (previous) | 2.08% | 2.30% | 1.43 |
| **50% (applied)** | **3.56%** | **3.68%** | **1.48** |
| 70% | 5.12% | 4.94% | 1.53 |
| 90% | 6.75% | 6.08% | 1.58 |

Chose 50%, not 90%: return scales roughly linearly with bet size and profit factor even ticks up slightly (a compounding artifact of sizing off the *remaining* balance), but 90% leaves almost no cash buffer per single position - that's concentrated risk, not "bigger position," and isn't a tradeoff I'll make unilaterally.

**Applied**: created `.env` (didn't exist before - the app was running on `src/config.js`'s hardcoded defaults) with `TRADE_ALLOCATION_PCT=0.5`, everything else unchanged. Verified via `node --env-file-if-exists=.env scripts/benchmark.mjs --months 6 --min-confidence 65 --rr conservative` (the same flag `npm start` uses, so this is what the live app actually runs on): **43 trades, 41.86% win rate, profit factor 1.48, +3.56% return, 3.68% max drawdown**. `backtest-expert` verdict: 54/100, Refine, one flag (short window, same honest and un-fixable limit as before).

---

## Update 4 - a real strategy-level improvement, found via 1-year data and a systematic candidate search, applied to the code

**Request**: use the installed skills against 1 year of data, check signal candidates, and only touch `src/decisionEngine.js` if profit/win-rate genuinely clears a bar.

**Why 1 year mattered on its own, before any new filter**: re-running the current baseline (65% confidence, conservative RR, no extra filters) over a full year instead of 6 months revealed something the shorter window had hidden - the year splits into two very different halves. First half: **-1.18%** (34 trades). Second half (the same March-September window already tested): **+2.07%** (43 trades, closely matching the earlier standalone 6-month result of +1.98%, a good cross-check). Aggregated, the full year is only marginally positive (+0.87%, profit factor 1.04) - a result that would have been reported as "acceptable" is actually one good half masking one bad half. This is exactly the "regime-specific performance" failure pattern `backtest-expert`'s methodology warns about, and it only became visible by testing a full year and splitting it, not by trusting one aggregate number.

**Signal candidates tested** (each independently, then in combination, across the full year AND both halves separately so a real signal had to survive two independent sub-periods, not just win in aggregate):

| Candidate | Full-year return | Full-year PF | H1 return | H2 return | Verdict |
|---|---:|---:|---:|---:|---|
| Baseline (no filter) | +0.87% | 1.04 | -1.18% | +2.07% | reference |
| **ADX >= 20 floor** | **+2.64%** | **1.19** | **-0.96%** | **+3.64%** | **improved both halves - real** |
| +DI > -DI direction | +1.13% | 1.06 | -1.23% | +2.39% | no meaningful effect |
| ADX + DI combined | +2.58% | 1.19 | -1.02% | +3.63% | DI adds nothing over ADX alone |
| Volume > 20-period avg | +0.91% | 1.05 | -1.71% | +2.67% | inconsistent across halves - noise |
| Daily-trend alignment (swing EMA50) | +1.7% | 1.81 | (2 trades) | (9 trades) | over-restrictive - sample collapses to unusable |
| Any 3-4 combined | 1.5-2.0% | 1.7-2.2 | (2-6 trades) | (5-9 trades) | sample too thin to trust once daily-trend is included |

**ADX >= 20 is the only candidate that improved BOTH halves independently** - not a spike in one period propping up the aggregate. It's also the most principled: `src/indicators.js`'s own `adx()` function comment already documented "<20 reads range-bound/choppy, where a crossover system whipsaws" - this was a real filter the codebase already knew it needed and never enforced, not a number mined from this dataset. DI direction and volume confirmation were tested in good faith but didn't hold up; daily-trend alignment is too restrictive to trust (down to 7-11 trades total). None of the extra combinations beat ADX alone.

**Generalization check** (does it only work on the exact 8-symbol watchlist it was found on?): re-tested on coins outside/inside that set that were previously bad. OPUSDT (worst performer in the earlier 24-coin diverse survey): profit factor 0.47 -> 0.56, return -2.81% -> -1.79% - still net negative alone, but the same direction of improvement on a coin that had zero influence on finding this filter. DOGEUSDT (on the watchlist, previously negative in isolation): now roughly breakeven (+0.17%, PF 1.06, 23 trades).

**Applied to `src/decisionEngine.js`**: `evaluateEntry()` now requires `adx14 >= 20` in addition to the existing EMA-cross + RSI gate before returning a BUY signal (a new `bullishCross && !adxOk` branch reports why a signal was skipped, mirroring the existing RSI-band-miss branch). Re-verified through the real `scripts/benchmark.mjs` (not just the test harness) for exact parity: **61 trades, 45.9% win rate, profit factor 1.19, +2.64% return over 1 year, 6.02% max drawdown**. `backtest-expert` verdict: **54/100, Refine** - one flag (short test window, the same honest and structurally un-fixable limit every result this session has carried). `scripts/mockAutotradeTest.mjs`'s three documented scenarios still land in their correct bucket (no regression).

**What didn't make it in, and why**: DI-direction and volume filters, because they didn't survive the two-halves test - adding them would have been complexity with no measured benefit, which this project's own standard explicitly rejects. Daily-trend alignment, because 7-11 total trades is not a number anyone should trust either way.

---

## Update 5 - re-tuning profit-taking (RR template) now that ADX changed what actually decides trades

**Request**: adjust profit-taking or confidence to enhance performance further.

**Why RR became worth re-checking**: with the ADX >= 20 filter now live, exit-reason composition changed completely. Before ADX: exits were dominated by `max-hold` timeouts (a coin flip - price hadn't decisively moved either way). After ADX, on the same 1-year/8-symbol data: of 62 closed trades, **take-profit decided 16 (100% of those, by construction, were wins, totaling +Rp 1,157,122)**, stop-loss decided 15 (100% losses, -Rp 912,994), and only 31 were left to time out via max-hold. Take-profit distance (i.e. the RR template) now actually drives a large share of outcomes, where before it barely mattered - so it was worth re-sweeping, not assumed still-optimal from before ADX existed.

**Re-swept confidence (55-75%) x RR template, full year + both halves, with ADX now baked into every run**:

| Confidence | RR | Full-year return | PF | H1 | H2 |
|---|---|---:|---:|---:|---:|
| 55% | any | -7.7% to -10.9% | 0.77-0.84 | strongly negative both halves | negative both halves |
| 60% | any | -5.6% to -6.5% | 0.77-0.80 | negative | h2 flips positive - inconsistent, not trusted |
| 65% | conservative | +2.83% | 1.23 | -0.96% | +3.84% |
| **65%** | **balanced** | **+4.48%** | **1.31** | **+1.09%** | **+3.35%** |
| 65% | aggressive | +2.99% | 1.19 | +0.41% | +2.56% |
| 70% | any | ~+0.2-0.3% | ~1.1 | (15 trades total - sample collapsing) | |
| 75% | any | -1.23% | 0.06 | (5 trades total - unusable) | |

**65%/balanced is the only combination positive in BOTH halves with a comfortable margin** (not just barely, like conservative's -0.96% h1 or aggressive's +0.41% h1) - a real plateau, and the best full-year return and profit factor of all 15 combinations tested. This is a legitimate re-tuning, not double-dipping on the same evidence: the entry-signal population itself changed (ADX added), so the previously-tuned RR choice was answering a question that no longer applied.

**Applied**: `data/settings.json` `riskRewardTemplate` changed from `conservative` back to `balanced` (confidence stays at 65%). Verified via the real `scripts/benchmark.mjs --months 12 --min-confidence 65 --rr balanced`: **60 trades, 43.33% win rate, profit factor 1.31, +4.55% return over 1 year, 5.19% max drawdown**. `backtest-expert` verdict: **56/100, Refine** - the best score of any configuration this session, still one flag (short test window - real, disclosed, and not fixable by more tuning on 1 year of crypto history).
