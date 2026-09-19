# Sally Crypto Bot (project folder: robocrypto)

A simple, 24/7 crypto paper-trading dashboard - the sibling to `robotrader`, rebuilt from scratch for Binance USDT pairs instead of a single IDX stock. Same spirit (real market data, a rule-based robot, Telegram alerts, a trade journal you can trust), deliberately smaller: no login, no Postgres, no build step, zero npm dependencies. Branded "Sally Crypto Bot" in the UI; the code/folder keep the working name `robocrypto`.

**This is paper trading only.** It never places a real order or touches a Binance account - it reads Binance's public market data (no API key needed) and simulates buys/sells against a fake Rupiah balance. Nothing here is investment advice; see "Honest results" below.

## Features

- **Starting balance**: Rp 10,000,000 (simulated), configurable in `.env`.
- **Trades 24/7**: a background loop re-checks every watchlist coin every 60 seconds (configurable), independent of whether the dashboard is open.
- **Multi-coin**: BTC, ETH, and any other Binance USDT pair you add from the Market tab's "Top movers" list or by typing a symbol in Settings. Up to 4 coins can be held open at once (configurable), each getting a slice of the current cash balance.
- **Three trading strategies, auto-selected per coin**: the same swing (EMA20/50 daily) and scalping (EMA9/21, 15-minute) rule sets that were backtested on a year of real BBCA and BTC/USDT data earlier this session, plus a new day-trade mode (EMA9/21, hourly) for conditions in between. Each coin's daily ADX (trend strength) and ATR% (volatility) decide which of the three fits right now - a strong, contained trend recommends swing; a choppy range recommends scalping; anything in between recommends day-trade. A coin that's already in a position keeps that position's original mode and stop/target until it exits, even if the recommendation later shifts.
- **Binance kline integration**: live daily/15m/1h candles from Binance's public REST API for every tracked coin - no account, no key, no rate-limit risk beyond normal public usage.
- **Technical-analysis summary**: a Bearish/Neutral/Bullish gauge per coin (EMA trend, RSI, MACD histogram, ADX/DI), written in plain language, computed locally with no API cost by default. Optionally layer an OpenAI-generated paragraph on top (`AI_ADVISOR_MODE=openai` + `OPENAI_API_KEY`) - the number never depends on it.
- **Indicator-forward UI**: dark theme modeled on the reference screenshot - balance card, watchlist/market list, a coin detail page with the summary gauge, indicator grid, and Buy/Sell buttons, minimal body text.
- **Robot confidence, as a percentage**: every BUY/HOLD/SELL decision carries a 0-100% confidence score (EMA separation vs. volatility, RSI centering, ADX trend strength, +DI/-DI agreement), shown as a badge in the Market list and as a ring gauge + indicator-grid entry on the coin detail page. This is a transparent readout of how "textbook" the current setup looks by the strategy's own rules - not a backtested probability of winning, and it's said plainly in the UI.
- **Confidence-gated auto-trading**: in Settings, set the minimum confidence (default 55%) a BUY signal must clear before the robot actually opens a paper position - a signal below the bar is logged and shown ("signal seen, not executed") rather than silently dropped. Exits (stop-loss, take-profit, max hold, trend reversal) are never confidence-gated on purpose: gating a stop by confidence could leave a losing position open past its own risk plan.
- **Configurable take-profit/stop-loss template**: three risk templates in Settings - Conservative (1:1.5), Balanced (1:2, the exact ratio backtested), Aggressive (1:3). Each keeps the stop distance at the mode's own backtested ATR multiple and only scales the target, so switching templates changes how far you let a winner run, not how tightly losses are cut.
- **Chart timeframe, kline duration, and click-to-inspect**: the coin detail chart has its own timeframe switcher (15m / 1h / 4h / 1D, independent of whichever mode the robot is actually trading that coin under - 4h is chart-only, there's no fourth strategy), shows the candle interval and count above the chart, price axis labels and first/last dates on the chart itself, and a click on any candle shows its exact date/time and open/high/low/close.
- **Signal significance: BOS / CHoCH + support/resistance**: below the chart, a swing-pivot read of whichever timeframe you're looking at - classifies the latest structure break as a **BOS** (Break of Structure: price closed past the last swing high/low in the direction the swings were already going - continuation) or a **CHoCH** (Change of Character: it broke the *other* way - an early reversal warning), plus the nearest support and resistance zones clustered from recent swing highs/lows (shown with how many times each has been touched). This is a descriptive read of the chart only - it does not feed the robot's entry/exit rules, which stay exactly the backtested EMA-cross/RSI/ATR logic below.
- **Strategy parameters, in the open**: the Indicators card also lists the active mode's actual numbers - which EMAs are crossing, the RSI filter band, the stop-loss and take-profit ATR multiples (after your chosen risk template), and the max hold - so "why did/didn't it trade" is always answerable from the UI itself, not just the mode name.
- **Telegram push**: same bot-token/chat-ID setup as robotrader, configurable from the Settings tab or `.env`.
- **Trade journal-ready**: every simulated fill is a plain transaction record in `data/portfolio.json` - feed it into the `swing-trading-discipline` skill's journal script if you want R-multiple/expectancy tracking across these trades too.

## Honest results (read this before trusting the "recommended" badge)

The swing and scalping parameters here are exactly what were backtested on one year of real BBCA and BTC/USDT data earlier this session - and that backtest came out net-negative for both, after realistic costs (see the delivered Word report and CSVs). The day-trade mode and the swing/scalping/day-trade *picker* itself (based on ADX/ATR) are new and have **not** been separately backtested - they're a reasonable heuristic, not a proven edge. Treat every "Bullish" badge and "recommended" chip as a transparent readout of the rules, not a signal to trust blindly. This dashboard is built to watch the *process* (sizing, discipline, a clean record of every trade) run continuously - not because these three systems are known money-makers.

## Benchmarking the robot against real history

`scripts/benchmark.mjs` runs a walk-forward backtest of the live robot - the same `evaluateEntry`/`evaluateExit`/`recommendMode` code the app runs, not a re-implementation of it - against real Binance history, starting from the same Rp 10,000,000 balance and the same confidence threshold / risk template as your Settings:

```bash
node scripts/benchmark.mjs --months 3
```

It fetches daily, hourly, and 15-minute candles for each watchlist coin, replays a 15-minute clock across the whole window, and at each step re-derives exactly what the live app would have known at that moment (no lookahead) - which mode is recommended, whether a fresh entry signal fired, whether confidence cleared your threshold, and whether an open position hit its stop/target/max-hold/trend-exit. It prints a summary (return %, win rate, profit factor, max drawdown, signals blocked by the confidence gate) and writes the full detail to `benchmarks/<timestamp>/` (summary.json, trades.csv, equity-curve.csv) - a separate folder from `data/`, so a benchmark run never touches your live paper-trading balance or history.

This needs real internet access to Binance, which a sandboxed assistant session doesn't have - run it the same way you run `npm start`, on the machine where the app actually runs. Flags: `--months <n>`, `--min-confidence <pct>`, `--rr conservative|balanced|aggressive`, `--symbols BTCUSDT,ETHUSDT,...`, `--end <ISO date>`. Like the original swing/scalping backtest, this is still a rule-based simulation on historical prices, not a guarantee of future results - see "Honest results" above.

## Confidence % is not the same as "there's a signal"

A high confidence reading and an actual BUY signal are two different checks, and it's normal to see one without the other: `evaluateEntry()` only returns `BUY` on the bar where the fast EMA *freshly* crosses above the slow EMA with RSI confirming - one specific bar, not "any bar where the trend looks good." Confidence is scored independently on every bar, fresh cross or not, as a read of how textbook the current setup looks (EMA separation, RSI centering, ADX, +DI/-DI agreement). So a coin can sit at 80-90% confidence for days *after* a strong cross while deep in an established trend, with the robot correctly doing nothing (`HOLD`, reason: "No fresh bullish EMA cross on the latest candle") because there is no new entry to take - the cross already happened and, without a position, there's nothing to manage. The confidence threshold in Settings only gates a signal that *has* fired; it can never manufacture one. `scripts/mockAutotradeTest.mjs` reproduces this exact scenario (and the two cases where a trade does execute) against synthetic candles - see the comment at the top of that file for how to run it.

## Setup

```bash
cd robocrypto
cp .env.example .env    # edit balance, watchlist, Telegram token if you want
npm start                # no install step - zero dependencies
```

Open `http://localhost:3300`. That's it - no database, no login screen.

To keep it running in the background the way robotrader's restart script does, `restart-robocrypto.command` (double-click on macOS) stops any previous instance and starts a fresh one with output logged to `robocrypto.log`.

### Telegram

In Settings, paste a bot token (from [@BotFather](https://t.me/BotFather)) and the chat ID to DM, then "Send test". Trade fills push notifications by default (see `TELEGRAM_DEFAULT_CATEGORIES` in `src/notifications.js` to change which categories push vs. stay in-app only).

### Changing the coin universe

Edit `WATCHLIST` in `.env` (comma-separated Binance symbols, e.g. `BTCUSDT,ETHUSDT,SOLUSDT`), or add/remove coins live from the Settings tab - changes persist to `data/settings.json` and take effect on the next 60-second tick.

## Project layout

```
src/
  config.js        env-driven settings
  storage.js       flat-file JSON read/write (data/*.json) - no database
  binanceData.js   public Binance REST calls: klines, 24hr tickers, top movers
  marketData.js    fetch + indicator-enrich + short in-memory cache, per coin/mode
  indicators.js    EMA/RSI/ATR/ADX/Bollinger/MACD (adapted from robotrader)
  decisionEngine.js  swing/scalping/day-trade entry+exit rules (backtested params)
  marketStructure.js swing pivots -> BOS/CHoCH signal + support/resistance (chart-only, informational)
  aiAdvisor.js     Bearish/Neutral/Bullish gauge + mode recommendation + summary text
  tradingRobot.js  paper portfolio: open/close positions, mark-to-market
  robotEngine.js   ties the above together per coin, per tick
  notifications.js in-app + Telegram push (adapted from robotrader)
  settings.js      watchlist / auto-trade / Telegram settings, flat-file backed
  websocket.js     hand-rolled WebSocket hub (no "ws" dependency)
  server.js        the http server, routes, and the 24/7 refresh loop
public/            the dashboard itself (plain HTML/CSS/JS, no build step)
data/              created on first run - portfolio.json, settings.json, notifications.json
```

## Safety notes

- No Binance API key is used anywhere in this codebase - only `https://api.binance.com/api/v3/*` public endpoints.
- No real funds ever move. `tradingRobot.js` only ever edits `data/portfolio.json`.
- If you ever want this to place real orders, that is a substantial and risky rewrite (signed Binance API calls, key storage, real slippage/liquidity handling) that should be done deliberately and separately - this project intentionally does not include it.
