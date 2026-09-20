# Portfolio T — Strategy Spec

Canonical summary of the Liberty Signal "Portfolio T" strategy, distilled from the
saved hub pages (`Start Here`, `Portfolio T · Strategy Hub`, `Findings & Model` —
hub.liberty-signal.com, saved 2026-09-19). This is the reference the app's behavior
is checked against. All performance figures are **modeled history**, not promises.

## Objective

Beat the S&P 500 by a wide margin, with less drawdown, trading a few minutes a day
around the close — no discretion, no stress. Edge: consolidation breakouts on
momentum stocks (momentum + volatility contraction/expansion).

Modeled results (frozen research, Jan 3 1995 – Jun 30 2026):

| Portfolio | CAGR | Max DD | MAR | Avg R |
|---|---|---|---|---|
| LS v3 Breakout standalone | +41.21% | −33.66% | 1.224 | +0.235R |
| LS Pullback standalone | +10.44% | −16.40% | 0.637 | +0.262R |
| QLD Trend Following (100% diagnostic) | +26.68% | −63.30% | 0.422 | — |
| **Portfolio T (all combined)** | **+61.55%** | **−25.93%** | **2.374** | +0.246R |

## Portfolio structure

Three sleeves inside one account:

1. **LS v3 Breakout** — the stock book and foundation; 1% risk per trade.
2. **LS Pullback** — three long-only pullback legs.
3. **QLD Trend Following** — a 35%-target sleeve, always QLD or cash.

The two stock sleeves share a **210% transaction-notional cap** (booked gross
notional / account value). QLD sits outside this cap.

### Admission order (per session)

1. Process every full exit.
2. Process scheduled partial exits.
3. Queue LS v3 Breakout candidates — sorted by **descending stop %**.
4. Queue LS Pullback candidates — descending stop %, ties **Daily → Weekly →
   NAS Weekly**.
5. Mark the account to close.

LS v3 Breakout gets first claim on capacity. A rejection does **not** stop the
queue — a later, smaller candidate can still fit. The frozen model never accepted
a same-ticker/same-day pair across the two sleeves.

## LS v3 Breakout

**Universe:** 20-day average daily dollar volume > $20M · close > $1 · ADR% > 1%.

**Long setup:** first leg off a multi-week/month base or a 50-EMA trend reset;
8/20/50 EMAs stacked upward with slope; CML green; first valid consolidation
against the 8/20 EMAs — ≥7 days, higher low, no daily close below the 20 EMA,
defined resistance/trendline; a strong breakout candle with no upper wick closing
through it (1–3 tight candles beforehand improve it). **Short** mirrors this
(downward stack, lower highs, no close above 20 EMA, strong candle through
support; CML still green).

**Entry:** the published price condition — e.g. "closing above $416.30 → LONG" —
evaluated in the final ~2 minutes (3:58–4:00pm ET). Enter at market if the
condition holds.

**Sizing & stop:** risk 1% of account per trade. Stop at the signal/breakout
candle's low of day (long) or high of day (short). No breakeven stop, ever.

**Exits (longs), by breadth regime** — regime = Net New Highs−New Lows, EMA8 vs
EMA20:

- **Expanding (8 > 20):** stop at LOD + fixed **1:6 take-profit** + exit at end of
  **day 5**.
- **Declining (8 < 20):** stop at LOD + **40% partial at 1:1** + remainder at 1:6
  + exit at end of day 5.
- **Shorts (either regime):** stop at HOD + exit at end of day 5. No TP leg.

**Regime gates (breadth filters):**

- *Longs:* LS ratio ≥ 1.2 required; skip when bull count < 100 or bear count > 250.
- *Shorts:* LS ratio ≤ 1.5 required; skip when bull count > 300, bear count
  outside 100–350, or % of NYSE stocks above their 40-MA < 20.

**Account-wide rules:**

- Stop size ≤ **2.5×** (longs) / **1.5×** (shorts) of the larger of ADR% / ATR%
  (20-day) — filters junk with oversized stops.
- **Circuit breaker:** −9% **realized** loss in a calendar month → no new trades
  until the next month.

## LS Pullback (long-only)

**Setup:** "Golden Dot" — an oversold pullback inside a confirmed uptrend.
**Entry:** at the signal candle's close.
**Stop:** entry − 1×ATR(5). **Exits:** 25% off at +1R (1:1); the remaining 75%
closes at the end of the **5th day** (daily) or **5th week** (weekly).

| Category | Risk | Timeframe | Universe |
|---|---|---|---|
| ETF Daily | 0.375% | daily | 19 ETFs |
| ETF Weekly | 0.75% | weekly | 19 ETFs |
| NAS Weekly | 0.25% | weekly | Nasdaq-100 stocks |

ETF universe: SPY, QQQ, IWM, DIA, MDY, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU,
XLC, SMH, SOXX, IBB, XRT, ITB.

**Weekly entries happen on the week's last trading day** (usually Friday; on
holiday-shortened weeks they may execute earlier — the model executed 37 such
candidates before their nominal Friday). Sizing: shares =
floor(account × riskPct / (ATR(5) + slippage)).

## QLD Trend Following

**Signal:** QQQ weekly EMA(12) vs EMA(26) on **completed** weekly closes — QQQ is
the signal, QLD is the vehicle. **ON** (12 > 26): hold the sleeve in QLD.
**OFF** (12 ≤ 26): sleeve in cash.

**Allocation:** 35% of account, reserved whether in QLD or cash. Timing switches
move the sleeve between QLD and cash at the **next session's open** (normally
decided Friday after close, executed Monday open); a switch carries the sleeve's
weight — it does **not** reset to 35%.

**Month-end band check (only at month-end):** sleeve value (including its
reserved cash when flat) / total equity — below 30% or above 40% → rebalance
toward 35% at the next open; inside the band (inclusive) → leave alone.

## Daily routine

1. **3:40pm ET** — update account value (PS Table / app account setting).
2. **3:50pm** — read the Discord EOD signals; note type, timeframe, entry
   condition.
3. **Fridays** — enter weekly pullbacks first (market-on-close orders after
   3:50pm).
4. **3:58–4:00pm** — enter daily LS v3 breakouts (on trigger condition) and daily
   pullbacks, staying under the 210% cap (v3 first).
5. **After the close** — load the published stop and partial-exit orders (longs
   use sell LMT partials).
6. **Weekend** — check the QLD timing; if a change is queued, place the order
   Monday morning.

## App mapping

| Rule | Where it lives |
|---|---|
| v3 signal parse ("closing above $X LONG") | `parseEodSignalText` / `parseSignalText` |
| Direction (published side) | signal `signalSide` → warn badge; default = green/red day |
| 1% sizing | risk input in percent mode + `getRealtimeFields` |
| Stop = LOD/HOD ± $0.01 | `getRealtimeFields` `stopPrice` |
| Expanding/declining exits | `opt1` / `opt2` via `regimeStrategyMap` + manual regime toggle |
| Shorts stop-only | `short16` built-in strategy |
| Day-5 timed exit | `timedExitEnabled` + `maxHoldDays` (opt-in; GAT/MOC orders) |
| PB categories/ATR(5)/exits | `PB_CATS`, `pbCatOf`, `pullbackAtrs`, `pbTimedExitDate`, `lspb` |
| PB ETF universe | `PB_DEFAULT_ETFS` (exact 19) |
| 210% cap | `PB_EXPOSURE_CAP` + `updateExposureChips` (booked) + `capProjection` (projected) |
| LS-first admission ordering | `admissionOrder` + `capProjection` → `capBadgeFor` FIT/OVER badges (cards/rows), `projChip`, `batchCapBanner` + `uncheckOverCap` — all advisory |
| −9% monthly breaker | `mtdRealizedPnl` + `circuitBreakerStatus` → `breakerBanner` (scanner pages) + `activeTradesBreaker` (journal page) — advisory only |
| Stop ≤2.5×/1.5× ATR/ADR | `stopVolatilityWarning` badge |
| QLD sleeve | QLD page (`qld*` functions; month-end band, next-open actions) |

Not modeled in-app (by design): CML/golden-dot detection (signals come
pre-filtered from Discord), the numeric breadth gates (manual Expanding/Declining
toggle; the app does not fetch LS ratio / bull-bear counts / % above 40-MA), and
the LS v3 universe checks ($-vol, price, ADR). The 210% admission projection and
the −9% circuit breaker are **advisory only** — the app never blocks an order.
