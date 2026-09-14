# Position Size Calculator

## Files and workflow

- App: `index.html`, a UTF-8 standalone HTML file with one inline application script.
- Preserve UTF-8 when editing; legacy PowerShell `Get-Content` followed by UTF-8 output previously corrupted icons and punctuation.
- `node _run_tests.js` runs the eight lightweight `_test_*.js` harnesses. No package installation is needed.
- `_test_golden.js` compares built-in strategy calculations/CSV with existing fixtures, normalizing OCA identifiers. Do not re-record fixtures to conceal regressions.
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
- Future option (not built): Node SEA variant — the bridge's `start()`/static-serving/meta-inject work is the shared foundation; SEA would esbuild-bundle server.js + postject into node.exe and auto-open the default browser.
