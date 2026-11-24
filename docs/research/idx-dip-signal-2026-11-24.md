# IDX small-profit dip signal (24 Nov 2026)

Joe asked for a second signal that takes small profits while the 55-day breakout is far away (BBCA's buy level is Rp 6,775 with the price at Rp 5,850). His rule: it only counts as a win if the win rate is high AND significant.

Data: Faridfarid/idx-market-data, 14 IDX stocks plus IHSG, 2010 to 20 Nov 2026, adjusted closes only. Entry and exit at the daily close, 0.4% round-trip cost, one trade per stock at a time.
Split: train 2010-2020, test 2021-2026. "Need" = the win rate needed to break even. z above 1.96 = significant. I tested 9 signals x 5 exits x 2 market filters (90 combinations), so only z above about 3.3 survives that many tries.

## Winner: RSI(2) dip in an uptrend
- **Buy:** the stock closes above its 200-day average and its 2-day RSI is under 10 (a short, sharp dip inside an uptrend).
- **Sell:** the first close above the 5-day average, or after 10 trading days at the latest.

| | Trades | Win % | Need % | z | Avg net per trade | Avg days |
|---|---|---|---|---|---|---|
| Train 2010-20 | 631 | 67.4 | 58.2 | **4.67** | +0.53% | 3.8 |
| Test 2021-26 | 543 | 67.8 | 58.0 | **4.62** | +0.48% | 3.8 |
| Test, only when IHSG > 50d | 299 | 69.6 | 56.1 | **4.70** | +0.61% | 3.6 |

- The win rate was 58-75% in every calendar year from 2011 to 2026.
- The average win is +2.25% and the average loss -3.12%.
- There is no price stop: the 5th percentile trade is -5.7% and the worst is -17.6%. The 10-day limit is the only exit for losers.
- Simple portfolio (4 slots of 25%, 14 stocks): +195% over 16 years (about +7%/yr), max drawdown 16.3%, about 70-120 trades/yr. With the IHSG > 50d filter: +140%, max drawdown 9.7%.

## Runners-up
- **Drop of 4% or more on volume at least 2x average, stock above its 200d, sell above SMA5:** train 70.9% vs 53.4% needed (z 3.12, 79 trades), test 67.1% vs 49.9% (z 2.95, 73 trades), +1.3% per trade. This fits Joe's preference for volume. It is good but rare, and the z score is below the multiple-testing bar.
- Lower Bollinger band, 3 down closes, and 10-day low: significant in only one period, or weaker.
- Fixed small targets (+2%/-4%, +3%/-5%) give lower z than the "close above SMA5" exit.

## Engine backtest (live engine loop, with the 55-day breakout, Rp 100M, max 4 positions)
`scripts/idxDipBacktest.mjs`. Dip uses a 10% disaster stop, which also sizes the trade (2% risk = about 20% of equity).

| Window | Breakout only | Breakout + dip | Dip trades / win % |
|---|---|---|---|
| 15y | +32.2%, DD 41.1% | **+124.9%, DD 27.0%** | 465 / 66% |
| 5y | +24.5%, DD 17.3% | +36.7%, DD 19.8% | 176 / 67% |
| 2y | +26.8%, DD 4.2% | +26.3%, DD 5.3% | 71 / 70% |
| 1y | +4.2%, DD 7.6% | +9.2%, DD 7.3% | 46 / 65% |
| 6m | +12.8%, DD 1.0% | +16.2%, DD 1.2% | 14 / 79% |

With a 15% stop: 15y +67.8%. With a 25% stop: 15y +57.6%. The 10% stop is live.

Caveats: close-only data (no intraday low, so the 10% stop is checked on closes here), and BBCA is not in the dataset.
