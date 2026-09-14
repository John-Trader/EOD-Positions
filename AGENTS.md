# Position Size Calculator

## Files and workflow

- App: `index.html`, a UTF-8 standalone HTML file with one inline application script.
- Preserve UTF-8 when editing; legacy PowerShell `Get-Content` followed by UTF-8 output previously corrupted icons and punctuation.
- `node _run_tests.js` runs the lightweight `_test_*.js` harnesses. No package installation is needed.
- `_test_golden.js` compares built-in strategy calculations/CSV with existing fixtures, normalizing OCA identifiers. Do not re-record fixtures to conceal regressions.
- `_test_pullback.js` covers the LS Pullback path (mixed parse, categories, ATR, timed exits, sizing); `_test_qld.js` covers the QLD tracker (weekly EMA, sleeve actions).
- User preference: no test dependency/browser installations or long browser soaks unless requested. Use focused existing checks.
- `_smoke_browser.js` is optional, requires Playwright, and is not part of the lightweight runner.

## Running and release

- `node _serve.js` serves the release assets at `http://localhost:8080` on loopback only.
- Release assets: `index.html`, `manifest.webmanifest`, `sw.js`, `icon.svg`, `_serve.js`.
- Do NOT copy release files to Downloads or anywhere else — the user deploys via git push to GitHub Pages (`levifasten/End-of-day`, `main` branch auto-deploys).
- PWA needs HTTPS or localhost; opening HTML directly works without service-worker support. Storage is origin-specific.
- TWS order sending is opt-in via `tws-bridge/` (local Node.js bridge) + Settings → TWS Bridge. When disabled the app is identical to the CSV-only version. CSVs remain the primary export path.
- **TWS API checklist (required):** enable "ActiveX and Socket Clients", set socket port (7497 paper / 7496 live), allow localhost-only, uncheck "Read-Only API", and enable **"Bypass Order Precautions for API Orders"** in API → Precautions.
- Timed/adjustable CSV orders are experimental and require paper validation; standard Option 1/2/Short fixed-stop exports must remain compatible.
- Increment the worker cache version when changing offline assets. Never cache quotes, credentials, backups or API traffic.

## Electron portable app

- `build-exe.bat` (or `npm install` then `npm run dist`) produces `dist/PositionCalc-<version>-portable.exe` — a single-file Windows build that runs the bridge in-process and opens the app in its own window. `npm start`/`npm run dev` runs the dev variant (`electron .`). User preference: do NOT rebuild the exe on code/version changes unless explicitly asked — dev iteration uses `npm start`.
- Electron files: `electron/main.js` (boot/window/IPC/log tee), `electron/preload.js` (settings seeding), `electron/chrome.html` + `electron/chrome-preload.js` (left dock strip with `>_` bridge-log terminal — a WebContentsView beside the app view; main tees `console.*` into a 2000-line ring buffer + `psc:log-line` push), `electron-builder.yml`, `tools/make-icon.js`.
- The bridge serves the app shell on loopback (`/`, `/index.html`, `/manifest.webmanifest`, `/sw.js`, `icon.svg`) and injects `<meta name="psc-bridge">` with the token → zero-config. `server.js` keeps standalone behavior via `require.main` — `start-bridge.bat` is unchanged.
- Settings persist to `psc-settings.json` next to the exe (PORTABLE_EXECUTABLE_DIR; falls back to userData). The app syncs the full backup payload + `apiKeys` via `window.pscBridge` — inert when absent (Pages/file:///_serve.js).
- Electron uses `IBKR_CLIENT_ID=8` so it can coexist with a standalone bridge (7).
- Keep versions in sync: `index.html` badge, `package.json`, `sw.js` cache name, `manifest.webmanifest`, backup whitelist.

## Multi-page scanner (v3.1.0)

- Pages: `scanner` (all strategies), `lsv3`, `pullback`, `qld`, `active-trades`, `manual-builder`, `settings`. `PAGE_IDS`/`PAGE_NAV` map them; `navigateTo` switches.
- The lsv3/pullback pages are cloned from the scanner markup at init (`buildScannerPages`) with ids stripped — generated pages are addressed by `data-role` via `pel()`/`pq()`/`pelAll()`. The legacy scanner page keeps real ids and is the `pel` fallback. Never add duplicate ids to cloned pages.
- Shared signal store: `signalSyncMode` ('shared' default | 'perPage') — `skey()` prefixes storage keys per page in perPage mode. `pbSignals` holds LS Pullback signals; `setPbSignals`/`loadPbSignals`/`renderPbEditor` manage it.
- `parseEodSignalText` splits mixed pastes into LS v3 / Pullback sections BEFORE strategy-specific parsing; headerless `- Daily`/`- Weekly` lines fall back to pb.
- Pullback categories (`PB_CATS`): etf_d 0.375% daily ATR(5), etf_w 0.75% weekly ATR(5), nas_w 0.25% weekly ATR(5); shares = floor(account×riskPct/(ATR+slippage)); stop = entry−1×ATR; 25% @1R + 75% timed day-5/week-5 exit (`lspb` built-in strategy + `pbTimedExitDate`).
- `pullbackAtrs` uses raw-OHLC daily bars from `volatilityCache[ticker].bars` (~14 months, folded with the live quote) resampled to weekly by `resampleDailyToWeekly`. Bridge `/history` accepts `duration` (default '1 M').
- Results carry `kind` ('v3'|'pb'); `selKeyFor`/`twsSendKey` produce `ticker`/`ticker:pb:kind` keys so the same ticker can exist in both strategies. Journal trades carry `sleeve`/`holdUnit`/`holdLimit`; `updateExposureChips` shows booked notional vs the 210% cap (QLD excluded).
- QLD page: weekly EMA12/26 on QQQ (completed weeks only — `isCurrentWeekForming`), 35% sleeve target with 30–40% band, manual ledger + journal logging.
- Future option (not built): Node SEA variant — the bridge's `start()`/static-serving/meta-inject work is the shared foundation; SEA would esbuild-bundle server.js + postject into node.exe and auto-open the default browser.
