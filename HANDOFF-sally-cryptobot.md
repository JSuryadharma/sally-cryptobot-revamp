# Handoff: Sally Crypto Bot trading-engine revamp

Context carried over from a Claude (Cowork) chat on 2026-09-26. That session could not reach the local repo, so everything below comes from the live API of the deployed app (https://sally-cryptobot-app.vercel.app) and has to be **checked against the actual code** before anything changes.

Repo: `~/Documents/sally-cryptobot-revamp` (paper-trading dashboard, deployed on Vercel).

## The user's goal

1. The bot doesn't react to market prices well enough to open scalping or swing trades automatically. Fix the trading trigger.
2. Get the win/loss profile to an acceptable level.
3. The user asked about down-averaging once a loss goes past the planned cut-loss. The advice was **not** to average down after the stop, because it removes the loss cap. Build a *planned scale-in* instead (details below). The user has not rejected that yet. Confirm with them before building it.

## Live settings (GET /api/settings, 2026-09-25)

- `autoTrade.enabled = true`, `minConfidencePct = 55`, `modeOverride = "scalping"`, `riskRewardTemplate = "balanced"` (2:1)
- `tradeAllocationPct = 0.3`, `maxOpenPositions = 4`, `roundTripCostPct = 0.2`, `refreshIntervalSec = 60`
- 18-symbol watchlist (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LSK, VTHO, TRX, APT, LTC, NEAR, ATOM, INJ, TON, ASTR, all USDT pairs)
- Strategy modes: swing (EMA20/50, daily), scalping (EMA9/21, 15m), dayTrade (EMA9/21, 1h)
- Data source: `https://data-api.binance.vision`; starting balance Rp 10,000,000; `usdIdrRate` 16800

## Evidence from trade history (12 automatic trades, 2026-09-12 to 09-15)

| Symbol | Conf % | Hold (min) | Price move % | P&L (Rp) | Exit |
|---|---|---|---|---|---|
| APT | 44 | 109 | +1.14 | +26,913 | max-hold 8 bars |
| INJ | 38 | 47 | −0.45 | −13,839 | trend exit |
| XRP | 39 | 90 | +0.02 | −5,011 | stop (stop 1.3711 was ABOVE entry 1.3706) |
| ADA | 55 | 30 | −0.38 | −8,494 | stop |
| BTC | 31 | 9 | −0.10 | −8,947 | stop (0.1% away) |
| INJ | 47 | 12 | −0.96 | −24,271 | stop |
| TRX | 72 | 41 | −0.12 | −9,482 | stop (0.03% away) |
| APT | 44 | 9 | −0.33 | −11,072 | stop |
| TRX | 65 | 154 | 0.00 | −5,458 | max-hold |
| LTC | 35 | 121 | −0.35 | −11,880 | stop |
| DOGE | 57 | 105 | +0.72 | +16,494 | max-hold |
| ASTR | 66 | 81 | −8.46 | −260,365 | stop (stop 0.007043, filled 0.006859) |

Totals: 2 wins out of 12 (17%). Average win Rp 21.7k, average loss Rp 35.9k, net −Rp 315k. No trades at all since 2026-09-15 even though autoTrade is on. No open positions.

## Diagnosis (hypotheses: verify in code)

1. **The engine only runs while someone calls it.** Trades land on the same second (:17) each minute while active, then there are gaps of hours or days. Exits get processed late in batches: the TRX timeout was due around 02:28 and ran at 03:01, together with the LTC stop, 0.5s apart. On Vercel, `refreshIntervalSec` is probably the dashboard's client polling. With the tab closed, nothing scans and stops aren't watched. This also explains the ASTR slippage (planned −6%, actual −8.5%) and the 11-day silence.
2. **The entry needs a one-bar "EMA9 *crossed* EMA21" event.** If the tick misses that candle, the signal is lost.
3. **`minConfidencePct` was apparently raised to 55 after launch.** 7 of 12 entries were at 31–47%. Only 2 trades since. Confidence didn't predict outcomes in this small sample.
4. **Stops are too tight compared with 0.2% round-trip costs**, and some stops ended up at or above entry (possibly buggy breakeven or trailing logic). Several "losses" are really just fees.
5. **Sizing is a fixed 30% allocation, not risk-based**, so the risk per trade swings wildly (ASTR ≈ Rp 170k planned risk).
6. **The 8-bar max-hold cuts winners short.** Both winners exited on the timeout.
7. **No filter against chasing or weak liquidity.** ASTR was entered at ADX 49.7 and RSI 65, on a thin, low-priced coin.

## Plan (phased; confirm each with the user before building)

**Phase 1: always-on engine (highest priority)**
- Separate the trading tick from the UI. Add a server-side tick endpoint (scan, entries, exits), called by a real scheduler every 1–5 min. Options: Vercel Cron if the plan allows that frequency, an external cron pinger with a secret header, or a small always-on worker using Binance websocket prices for stops.
- Make the tick idempotent (lock or dedupe so overlapping runs can't double-trade).
- Log each tick (time, symbols scanned, signals, skip reasons) so a "quiet day" can be told apart from "engine not running".

**Phase 2: risk and exits**
- Risk-based sizing: qty = (equity × riskPct) ÷ (entry − stop), with riskPct 0.5–1% and still capped by `tradeAllocationPct`.
- Stop = entry − max(1.5 × ATR, entry × 3 × roundTripCost). Skip setups whose target is under about 4× costs.
- Find out why stops end up at or above entry (XRP) and fix it.
- Exits: take a partial at 1R, move the stop to breakeven, trail the rest (ATR or EMA21). Max-hold becomes a longer backstop (e.g. 16–24 bars), used only when the trade is below +0.5R.
- Guardrails: daily loss limit (e.g. −2% of equity or 3 losses in a row → pause), plus a per-symbol cooldown after a stop.

**Phase 3: better triggers**
- Replace the "cross event" with a "state + recent cross" check (EMA9 > EMA21 and the cross happened within the last N bars), evaluated on candle close.
- Higher-timeframe filter: 1h trend for scalping, daily for swing.
- Pullback entry within an existing trend (near EMA21, RSI turning back up from 45–50).
- Anti-chase filter (skip if price is more than about 1.5 ATR above EMA21) and a liquidity/price filter.
- Re-check how confidence is calculated and whether the 55 threshold makes sense.

**Phase 4: planned scale-in (instead of averaging down past the stop)**
- Decide the tranches and one stop for the whole position at entry. Add only on a pullback that is still above the stop, while the higher-timeframe trend holds. At most 1 add. Never add after the stop. Swing mode on liquid coins only.

```ts
// sketch - adapt to the real code
const riskIdr = equity * 0.01;
const stop = entry - Math.max(1.5 * atr, entry * 0.006);
const addPrice = entry - 0.5 * (entry - stop);
const avgEntry = (entry + addPrice) / 2;
const totalQty = riskIdr / (avgEntry - stop);   // loss at stop == riskIdr, even after the add
const tranche = totalQty / 2;
```

**Phase 5: validate**
- Re-run the backtest with the 0.2% costs included, before and after the changes. Paper-trade for about 2 weeks before judging.

## Guardrails for the coding session

- Work on a branch. Don't push or deploy until the user says so.
- Don't change live settings on the deployed app. Don't call state-changing endpoints (`POST /api/settings`, `/api/coins/*/trade`, `/api/coins/refresh-all`) on production.
- A daily read-only scheduled check emails the user at 16:00 WIB. It reads `/api/portfolio`, `/api/notifications` and `/api/settings`. Keep those response shapes compatible (`transactions[].createdAt/type/symbol/price/reason/realizedProfitIdr`, notification messages containing "Confidence NN%").

## First prompt to paste into Claude Code

> Read HANDOFF-sally-cryptobot.md in the repo root. Then explore the codebase and tell me which diagnosis points are confirmed or wrong, with file/line references, before changing anything. After that, propose the Phase 1 implementation.
