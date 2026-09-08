# TWS Bridge

A small local bridge that lets the End-of-Day app send orders directly to Interactive Brokers TWS via the TWS API.

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
   or double-click `start-bridge.bat`.

4. On first run, the bridge prints a **token**. Paste it into the app's **Settings → TWS Bridge → Bridge token** field. The token is saved in `.bridge-token` and reused on subsequent runs.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TWS_HOST` | `127.0.0.1` | TWS host |
| `TWS_PORT` | `7497` | TWS socket port (paper=7497, live=7496, IB Gateway paper=4002, live=4001) |
| `IBKR_CLIENT_ID` | `7` | API client ID — must not conflict with another API connection |
| `BRIDGE_PORT` | `8787` | Local HTTP port the app talks to |
| `BRIDGE_TOKEN` | auto-generated | Shared secret; set to override the auto-generated token |
| `BRIDGE_ALLOW_NULL_ORIGIN` | unset | Set to `1` to allow `file://` pages (off by default) |

## Troubleshooting

| Error | Fix |
|---|---|
| `clientId 7 already in use` | Another API client is using id 7. Set `IBKR_CLIENT_ID` to a different number. |
| `Invalid or missing bridge token` | Paste the printed token into the app's Settings → TWS Bridge. |
| `No security definition` (code 200) | Symbol not found — check the ticker (e.g. `BRK.B` becomes `BRK B` automatically). |
| `Read-only API` (code 10268) | Uncheck "Read-Only API" in TWS API settings. |
| Order rejected (code 201/202) | Check the message — market closed, insufficient margin, etc. |
| TWS popup per order | Enable "Bypass Order Precautions for API Orders" in API → Precautions. |
| Bridge not connecting | Confirm TWS is running and the socket port matches `TWS_PORT`. |

## Security

- The bridge binds to `127.0.0.1` only — never exposed to the network.
- All POSTs require `Content-Type: application/json` + a matching `X-Bridge-Token` header.
- CORS is restricted to `https://levifasten.github.io` and `localhost`/`127.0.0.1` origins.
- `Origin: null` (file://) is rejected unless `BRIDGE_ALLOW_NULL_ORIGIN=1` is set.
