# IBKR Flex reconcile — setup

The app can pull your official IBKR account report through the local bridge and
reconcile the journal against it: fills the app missed while closed get
journaled at real prices, position-delta estimates get upgraded to confirmed
executions, and every fill gains its **exact commission** (shown per-trade in
History and per week/month on the REPORT tab — commissions are display-only and
never change entry cost or report P&L).

This is read-only reporting data — Flex can never place orders. The live TWS
stream stays the intraday path; Flex is the end-of-day truth pass.

## One-time Client Portal setup

1. Log into **Client Portal** → **Performance & Reports → Flex Queries →
   Flex Web Service Configuration** → enable the service → **Generate a new
   token** (pick a long expiry; IP-restriction optional). Copy the token.
2. **Flex Queries → Activity Flex Query** → create one:
   - **Sections:** `Trades` — tick these fields:
     `Symbol`, `Date/Time`, `Quantity`, `Trade Price`, `Buy/Sell`,
     `IB Commission`, `IB Exec ID` (optional: `Currency`, `NetCash`,
     `IB Order ID`, `Perm ID`)
   - **Format:** `CSV`
   - **Period:** `Last 7 Calendar Days` (any period works — this is what each
     reconcile pulls)
   - **Date format:** `yyyyMMdd`, time `HHmmss`, separator `;` (the default
     compact format — the parser also accepts `yyyy-MM-dd HH:mm:ss`)
3. Copy the **Query ID** shown on the Flex Queries list.

## App setup

Settings → TWS → **IBKR Flex reconcile**:

- **Flex token** + **Query ID** — paste both. They're stored machine-locally
  (never synced, never in backups).
- **Reconcile now** — pulls the report immediately.
- **Auto at HH:MM** — runs once per day at that New York time while the app is
  open. Pick an evening time (default 18:00) — same-day confirms are only
  available after IBKR processes them post-close.

## What a reconcile does

For each trade row in the report, in chronological order:

- **Already-seen exec** → confirms/upgrades the commission on the journal event
  (and the flat row via the normal late-commission path).
- **Matches an estimate or execId-less event** (same ticker/qty/direction) →
  amends it in place with the real price, date, execId and commission.
- **Otherwise** → runs through the normal fill classifier (entry/add/exit/QLD)
  exactly as if the fill had arrived live — with toasts silenced and a single
  summary at the end.

Nothing is ever ordered, cancelled, or deleted by a reconcile. Ambiguous
matches are left alone and counted as skipped.

## Requirements & limits

- The **bridge must be running** (the exe has it built in; browser/web
  deployments don't — the feature stays inert there).
- TWS doesn't need to be connected for the fetch itself; held-position data
  improves classification when it is.
- IBKR rate-limits the service: **1 request/sec, 10 requests/min per token**.
  A reconcile is a handful of requests — fine for daily use.
- Common errors: `1012` token expired (regenerate in Client Portal), `1013`
  IP restriction, `1015` invalid token, `1019` report still generating (the
  bridge retries automatically for ~60s).
