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
- No backend, broker connection, or automatic order submission exists. CSVs must be reviewed/imported in TWS.
- Timed/adjustable CSV orders are experimental and require paper validation; standard Option 1/2/Short fixed-stop exports must remain compatible.
- Increment the worker cache version when changing offline assets. Never cache quotes, credentials, backups or API traffic.
