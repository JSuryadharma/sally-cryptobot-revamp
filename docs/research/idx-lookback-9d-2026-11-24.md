# IDX breakout: 9-day vs 20-day vs 55-day high (24 Nov 2026)

Joe asked about a 9-day high, since the 55-day buy level for BBCA (Rp 6,775) is 15.8% above the price. Joe's rule: it only counts as a win if the win rate is high AND statistically significant.

Setup: the live engine loop (core.js advance, idxEngineCfg), IHSG > 50-day filter, stop 3 ATR, Rp 100M, 0.4% costs, max 4 positions.
Data: Faridfarid/idx-market-data, 14 stocks (ADRO ANTM ASII AUTO BRIS INDF IPCC PGAS POWR SIDO TLKM TOTL TOTO UNTR) plus real IHSG, 2010 to 20 Nov 2026. These are adjusted closes only, so the highs and ATR are built from closes. BBCA is not in this dataset.
"Need" = the win rate needed to break even given the average win and loss sizes. z = how far the win rate is above that level (above 1.96 is significant at 95%).

## With the skill risk gate on (live)
| Rule | Window | Trades | Win % | Need % | z | Avg R | Return | Max DD |
|---|---|---|---|---|---|---|---|---|
| 9d +2R | 15y | 497 | 41.4 | 39.5 | 0.89 | +0.05 | +11.7% | 32.9% |
| 9d +2R | 5y | 166 | 39.2 | 38.4 | 0.21 | +0.02 | -2.9% | 19.7% |
| 9d +2R | 2y | 55 | 43.6 | 38.2 | 0.83 | +0.13 | +2.4% | 13.5% |
| 9d +2R | 1y | 29 | 34.5 | 36.1 | -0.18 | -0.04 | -5.1% | 11.9% |
| 20d +2R | 15y | 458 | 44.1 | 39.2 | **2.14** | +0.12 | +98.1% | 24.8% |
| 20d +2R | 5y | 152 | 46.1 | 40.3 | 1.44 | +0.14 | +31.4% | 13.3% |
| 20d +2R | 2y | 55 | 47.3 | 40.5 | 1.03 | +0.16 | +7.4% | 8.3% |
| 20d +2R | 1y | 29 | 41.4 | 35.2 | 0.70 | +0.16 | +3.2% | 6.9% |
| 55d +2R (live) | 15y | 376 | 41.8 | 39.2 | 1.00 | +0.06 | +32.2% | 41.1% |
| 55d +2R (live) | 5y | 122 | 45.9 | 40.2 | 1.28 | +0.14 | +24.5% | 17.3% |
| 55d +2R (live) | 2y | 41 | 61.0 | 40.6 | **2.65** | +0.47 | +26.8% | 4.2% |
| 55d +2R (live) | 1y | 22 | 45.5 | 37.2 | 0.80 | +0.20 | +4.2% | 7.6% |

The +1R targets take no trades with the gate on, because it requires reward:risk of at least 1 after costs.

## Gate off, high-win-rate +1R targets
| Rule | 15y win % / need % / z | 2y win % / need % / z | 15y return |
|---|---|---|---|
| 9d 3ATR +1R | 50.5 / 55.3 / -2.85 | 49.4 / 55.3 / -1.12 | -66% |
| 9d 2ATR +1R | 46.9 / 57.9 / -7.71 | 45.3 / 57.8 / -2.97 | -87% |
| 20d 3ATR +1R | 50.9 / 54.9 / -2.15 | 55.4 / 54.0 / 0.24 | -42% |
| 55d 3ATR +1R | 51.2 / 54.8 / -1.75 | 59.7 / 52.3 / 1.16 | -41% |

## Conclusion
- The 9-day high fails Joe's test. Its win rate is never significantly above break-even, and the +1R version wins about 50% when it needs about 55%, so it loses significantly.
- Only two results pass: the 20-day high over 15 years (z 2.14) and the 55-day high over the last 2 years (z 2.65).
- A 9-day buy level sits close to the price, but those breakouts are mostly noise in IDX stocks.
