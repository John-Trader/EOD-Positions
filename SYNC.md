# Cloud Sync

Optional, off by default. When configured, the app pushes its state envelope
(journal, ledger events, valuations, report data, settings) to a remote store
after local changes and pulls/merges on startup. Works identically in the
GitHub Pages/browser build and the portable `.exe` (which keeps
`psc-state-v1.json` as local storage; sync rides on top).

Configured in **Settings → Cloud Sync**.

## Conflict model

**Per-record last-change-wins.** Every record (each trade, ledger event,
valuation day, cash flow, setting, …) carries a revision stamp
`(wallMs, logical, deviceId)`. A pull merges the remote into local state by
record — your open trade edit survives even when the remote is newer overall —
and the merged result is applied atomically. Deletions travel as tombstones.
Same-record conflicts resolve by revision stamp.

The payload itself is still a single JSON document, so **how safe a
simultaneous push is depends on the provider**:

| Provider | Concurrent-push safety |
|---|---|
| **Google Apps Script** | **Atomic.** The script takes a script lock and compare-and-swaps on the stored `savedAt` stamp; a losing push gets a conflict reply, re-merges, and retries. |
| JSONBin / npoint / Pantry / custom | Best-effort. The app always merges immediately before writing, so the loss window is the pull→push gap (sub-second). If two devices write inside that gap, the later whole-document write wins. |

Do not run two devices with unsynced edits at the *same instant* on
replace-only providers. Sequential use — even alternating devices — is fully
safe: every push merges first, so nothing is lost.

## Providers

| Provider | You enter | Setup | Notes |
|---|---|---|---|
| **Google Apps Script** | Endpoint URL | Deploy `apps-script.gs` once (~5 min) | Data lives as a file in **your own Google Drive**. Atomic CAS writes. Most private free option. |
| **JSONBin.io** | Bin ID + API key | Free account → create a bin → copy Bin ID + X-Master-Key | Private bins; key stays on your device. |
| **npoint.io** | Bin ID | Create a bin at npoint.io, copy its ID | No signup. **Public by URL.** |
| **Pantry** | Pantry ID + basket name | Free account at getpantry.cloud | ⚠ Deletes data after ~90 days of inactivity. |
| **Custom endpoint** | URL | Any service that accepts `GET` (read) and `PUT`/`POST` (write) of the JSON body | Your own server, a Cloudflare Worker, etc. |

### Google Apps Script setup

1. Open https://script.google.com → **New project** → paste the contents of
   [`apps-script.gs`](apps-script.gs).
2. **Deploy → New deployment → Web app**: *Execute as: Me*, *Access: Anyone*.
3. Copy the `.../exec` URL into the app's Endpoint URL field.

The script stores the payload as `positioncalc-sync.json` in your Drive.
"Anyone" access + the long random URL is the only protection — treat the URL
like a password and never commit it. If you already deployed an older copy of
the script, redeploy with the current `apps-script.gs` — the CAS write path
needs it (older copies still accept pushes but can't conflict-guard them).

## Reliability

- A failed or deferred push sets a durable outbox flag (`syncPending`) that
  survives restarts — the next boot re-attempts it after the pull-merge.
- A push that arrives while another sync is in flight is queued, not dropped.
- Remote payloads are validated like imported backups before being applied;
  a corrupt remote copy cannot overwrite good local state.
- Machine-local intent never leaves the device: QLD pending orders, in-flight
  TWS fill bookkeeping, bridge URL/token and API keys are excluded from the
  sync payload, and a merge restores your local intent fields even when the
  remote record wins.
- Sync failures never block trading, journaling, or exports — the app works
  fully offline and just retries on the next change/pull.
- The service worker never caches sync traffic.
