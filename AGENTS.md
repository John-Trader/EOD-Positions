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
