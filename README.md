# Sally Crypto Bot (project folder: robocrypto)

A 24/7 crypto paper-trading robot and dashboard for Binance USDT pairs. It reads Binance's public market data (no API key), simulates buys and sells against a paper Rupiah balance, and explains in plain language what it is about to do and why.

**Paper trading only.** It never places a real order or touches a Binance account. Nothing here is investment advice.

## What the robot does

- **Strategies** (Settings > Auto-trading):
  - **Breakout** (on by default): daily candles. Buys when a coin closes above its prior 20-day high while Bitcoin's daily close is above its 200-day average. The stop is 2x ATR below the entry. It sells at +1R, otherwise after 30 days. There is no breakeven move and no trail, so it trades exactly as researched. It was the only entry that made money both on the data it was tuned on and on the later test period of `npm run research -- --months 36`. The evidence is still thin (30-54 test trades), which is why it runs on paper.
  - **Swing / Trend** (off by default): 4-hour or daily trend pullbacks. They lost money on the research test period (−0.18R to −0.51R per trade). Settings saved before the switch move to the new defaults once.
  - **Scalping** (15-minute candles) is available but off by default. It lost money in every backtest once trading costs were included.
- **Pullback entry (Swing / Trend).** Every condition has to hold on a closed candle:
  1. The higher-timeframe trend is up, and Bitcoin is above its daily EMA50.
  2. The coin has enough volume and movement.
  3. The trading timeframe is in an uptrend.
  4. Price pulled back to the EMA20 within the last 5 candles.
  5. The newest candle closes above the previous candle's high.
  6. Price is not stretched far above the EMA20.
- **Risk:**
  - Each trade risks 2% of equity at its stop-loss (configurable), with position size capped at 30% of equity, up to 6 coins open and up to 6 new buys on one daily close.
  - Total open risk is capped, and new entries pause after a daily loss, a losing streak, or a drawdown.
  - Exits are never paused.
- **Pullback exits:**
  - Stop-loss below the pullback low.
  - Sells the whole position at a fixed take-profit of +1.5R (1.5x the stop distance above the entry). There is no breakeven move and no trailing stop.
  - A time stop for trades that go nowhere.
  - Stops fill at the stop price on the candle that touched them, even if the engine runs late.
- **Predictions:** for every coin the dashboard shows:
  - the stage: not in play, watching, setting up, ready, or holding;
  - which of the conditions pass;
  - the exact trigger price and when the deciding candle closes;
  - the trade it would place (entry, stop, size, money at risk);
  - anything that would stop it firing.

## How it runs

The server does no trading on its own timer on Vercel. An external scheduler ([cron-job.org](https://cron-job.org)) calls `POST /api/engine/tick` every 5 minutes, at minutes 1, 6, 11, … 56, with the header `Authorization: Bearer <ENGINE_TICK_SECRET>`. That lands each tick 1 minute after every 5-minute candle close, including each 4h and daily close. Each tick:

1. Takes a Postgres lease, so two ticks can never trade at once.
2. Replays any candles it missed.
3. Saves the portfolio and engine state in one transaction.
4. Sends Telegram alerts.
5. Writes the dashboard's per-coin predictions.

Opening the dashboard never trades. Running locally, `npm start` also ticks on a timer.

The engine lives in `src/engine/`. `core.js` is pure and shared by the live tick and the backtester, so a backtest runs exactly the code that trades.

## Setup

```bash
cp .env.example .env    # DATABASE_URL (Postgres), PORT, ADMIN_TOKEN, ENGINE_TICK_SECRET
npm install
npm start               # http://localhost:3300
```

On Vercel, set these environment variables:
- `DATABASE_URL`
- `ADMIN_TOKEN`: protects settings changes and manual trades. Backtests run without it. The dashboard asks for it once.
- `ENGINE_TICK_SECRET`

On cron-job.org, create a job that POSTs to `https://<your-app>/api/engine/tick` with the header `Authorization: Bearer <ENGINE_TICK_SECRET>`, on a custom schedule at minutes `1,6,11,16,21,26,31,36,41,46,51,56`.

## Backtesting

```bash
npm run backtest -- --months 12
```

This runs `src/engine/core.js` over real Binance history, with 0.2% round-trip costs plus 0.05% slippage per fill. It prints win rate, profit factor, expectancy in R, drawdown and a 0.3% cost stress test, and writes a report to `benchmarks/v2-<timestamp>/`.

Two flags:
- `--train <months>` adds a small parameter grid on the earlier part of the window.
- `--no-cache` refetches history.

`docs/engine-v2-summary.pdf` documents the 2024-2026 results. v2 beat the previous engine on both test years. On the most recent year it was roughly flat after a market crash, and it did not pass the strict pass criteria set before testing. Judge it on live paper results, not on a single backtest.

## Tests

```bash
npm test     # engine, sizing, exits, catch-up replay, predictions
npm run check
```

## Project layout

```
src/engine/       trading engine: config, setups, prediction, position manager, sizing,
                  risk brakes, ledger, core loop, candles, coin views, tick
src/server.js     http routes (dashboard API, tick endpoint, static files)
src/settings.js   stored settings and engine configuration
src/tradingRobot.js  stored paper portfolio
src/aiAdvisor.js  daily-chart summary (local, or OpenAI if configured)
src/marketStructure.js  swing pivots and support/resistance for the chart
api/engine/tick.js      Vercel function called by the cron-job.org schedule
scripts/backtest.mjs    walk-forward backtester
public/           dashboard (plain HTML/CSS/JS, no build step)
test/             node --test suites
```

## Safety notes

- No Binance API key is used anywhere, only public market-data endpoints.
- No real funds ever move. The portfolio is a record in Postgres.
- Placing real orders would be a separate, deliberate project (signed API calls, key storage, real fills), and this codebase does not include it.
