# TWS Bridge

A small local bridge that lets the End-of-Day app talk to Interactive Brokers TWS via the TWS API — sending orders, streaming quotes, and reading account/positions/fills/P&L.

## Setup

1. Install dependencies (one-time):
   ```
   cd tws-bridge
   npm install
   ```

2. Configure TWS (required, one-time):
   - Open TWS → **File → Global Configuration → API → Settings**
   - Check **"Enable ActiveX and Socket Clients"**
   - Set **Socket port** to `7497` (paper) or `7496` (live)
   - Check **"Allow connections from localhost only"**
   - **Uncheck** "Read-Only API"
   - Go to **API → Precautions** → enable **"Bypass Order Precautions for API Orders"** (required — without it TWS shows a manual confirmation popup per order)

3. Start the bridge:
   ```
   node server.js
   ```
   or double-click `start-bridge.bat` (it auto-runs `npm install` if `ws` is missing).

4. On first run, the bridge prints a **token**. Paste it into the app's **Settings → TWS Bridge → Bridge token** field. The token is saved in `.bridge-token` and reused on subsequent runs.

## Endpoints

All endpoints bind to `127.0.0.1` only. `GET /health` is token-free; every other endpoint requires the `X-Bridge-Token` header. CORS is restricted to the GitHub Pages origin and localhost.

| Endpoint | Description |
|---|---|
| `GET /health` | `{connected, account, nextOrderId, netLiq, dailyPnL, twsPort}` — status probe |
| `POST /order` | Single order `{symbol, action, orderType, quantity, ...}` |
| `POST /orders` | Batch `{orders:[...]}` — `parentRef` resolves to `parentId` for brackets/OCA |
| `POST /cancel` | `{orderId}` — cancel one order, resolves on `Cancelled` status |
| `POST /cancel-all` | `{scope:'psc'}` (default) cancels only `PSC-*` orderRef orders; `{scope:'all'}` cancels everything the client can see — one-by-one, never `reqGlobalCancel` |
| `GET /quote?symbol=` | Snapshot quote `{c,h,l,pc,bid,ask,delayed,t}` via `reqMktData(snapshot)` |
| `GET /account` | `{account, values:{NetLiquidation,...}, asOf}` |
| `GET /positions` | `[{symbol,qty,avgCost,mktPrice,mktValue,unrealizedPNL}]` |
| `GET /orders` | `[{orderId,permId,symbol,action,qty,type,lmtPrice,auxPrice,status,orderRef,parentId,ocaGroup}]` — includes manual TWS orders via `reqAutoOpenOrders` |
| `GET /executions` | Today's fills `[{execId,orderId,orderRef,symbol,side,shares,price,time,commission,realizedPnl}]` |
| `GET /pnl` | `{dailyPnL,unrealizedPnL,realizedPnL}` |
| `GET /contract?symbol=` | `{ok,conId,longName}` — symbol preflight check |
| `GET /history?symbol=` | ~1 month of daily bars `[{h,l,c}]` for ATR/ADR |
| `WS /stream` | Streaming channel — see below |

## WS /stream

`ws://127.0.0.1:8787/stream`

1. Browser opens the socket and sends `{type:'auth', token:'<bridge token>'}` within 3s.
2. Then `{type:'subscribe', tickers:['AAPL',...]}` — the bridge refcounts subscriptions across clients so multiple tabs share one `reqMktData` per ticker.
3. Server pushes `{type:'tick', s, c, bid, ask, h, l, t, delayed}` plus `status` / `account` / `position` / `order` / `exec` / `pnl` events.
4. `{type:'unsubscribe', tickers:[...]}` releases subscriptions; socket close releases all.

## Live quotes and market-data subscriptions

Real-time quotes require market-data subscriptions on the IBKR account
(**Account Management → Market Data Subscriptions**). Without them, TWS returns
15-minute delayed data — the `delayed` flag in `/quote` and stream ticks will be
`true` and the app shows a `DELAYED` badge. Delayed ticks carry stale timestamps,
so in Enhanced Live Mode they automatically lose the race to any real-time feed.

Paper accounts: to share real-time data with a paper account, enable
**"Share market data subscriptions with paper trading account"** in TWS.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TWS_HOST` | `127.0.0.1` | TWS host |
| `TWS_PORT` | `7497` | TWS socket port (paper=7497, live=7496, IB Gateway paper=4002, live=4001) |
| `IBKR_CLIENT_ID` | `7` | API client ID — must not conflict with another API connection |
| `BRIDGE_PORT` | `8787` | Local HTTP port the app talks to |
| `BRIDGE_TOKEN` | auto-generated | Shared secret; set to override the `.bridge-token` file |

## Troubleshooting

| Error | Fix |
|---|---|
| `clientId 7 already in use` | Another API client is using id 7. Set `IBKR_CLIENT_ID` to a different number. |
| `Invalid or missing bridge token` | Paste the printed token into the app's Settings → TWS Bridge. |
| `No security definition` (code 200) | Symbol not found — check the ticker (e.g. `BRK.B` becomes `BRK B` automatically). |
| `Read-only API` (code 10268) | Uncheck "Read-Only API" in TWS API settings. |
| Order rejected (code 201/202) | Check the message — market closed, insufficient margin, etc. |
| `Failed to fetch` from the GitHub Pages site | Public HTTPS pages need the "Local network access" permission: padlock icon → **Site settings** → allow it for the site, then reload. Or use `http://localhost:8080` / `file://` — those origins aren't gated. |
| TWS popup per order | Enable "Bypass Order Precautions for API Orders" in API → Precautions. |
| Bridge not connecting | Confirm TWS is running and the socket port matches `TWS_PORT`. |
| All quotes delayed | No market-data subscription — see above. |

## Security

- The bridge binds to `127.0.0.1` only — never exposed to the network.
- All POSTs require `Content-Type: application/json` + a matching `X-Bridge-Token` header; all data GETs require the token header.
- CORS is restricted to `https://levifasten.github.io` and `localhost`/`127.0.0.1` origins (any localhost port).
- `Origin: null` (file://) is allowed — the app may run as a local file.
- The WS `/stream` enforces the same origin allowlist and requires the token as its first message.
