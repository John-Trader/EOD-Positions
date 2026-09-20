# Cloud Sync

Optional, off by default. When configured, the app pushes its full backup
payload (journal, ledger events, valuations, report data, settings) to a
remote store after local changes and pulls it on startup — the same payload
as **Export (.json)** plus a `syncedAt` timestamp. Works identically in the
GitHub Pages/browser build and the portable `.exe` (which keeps
`psc-settings.json` as local storage; sync rides on top).

Configured in **Settings → Cloud Sync**.

## Conflict model

Whole-state, **last-writer-wins by timestamp** — whichever side has the newer
`syncedAt` wins; there is no record-level merge. Do not run two devices with
unsynced edits at the same time. A pull only applies remote data when it is
strictly newer than local, so a pull can never trigger a push loop.

## Providers

| Provider | You enter | Setup | Notes |
|---|---|---|---|
| **Google Apps Script** | Endpoint URL | Deploy `apps-script.gs` once (~5 min) | Data lives as a file in **your own Google Drive**. Most private free option. |
| **JSONBin.io** | Bin ID + API key | Free account → create a bin → copy Bin ID + X-Master-Key | Private bins; key stays on your device. |
| **npoint.io** | Bin ID | Create a bin at npoint.io, copy its ID | No signup. **Public by URL.** |
| **Pantry** | Pantry ID + basket name | Free account at getpantry.cloud | ⚠ Deletes data after ~90 days of inactivity. |
| **Custom endpoint** | URL | Any service that accepts `GET` (read) and `PUT` (write) of the JSON body | Your own server, a Cloudflare Worker, etc. |

### Google Apps Script setup

1. Open https://script.google.com → **New project** → paste the contents of
   [`apps-script.gs`](apps-script.gs).
2. **Deploy → New deployment → Web app**: *Execute as: Me*, *Access: Anyone*.
3. Copy the `.../exec` URL into the app's Endpoint URL field.

The script stores the payload as `positioncalc-sync.json` in your Drive.
"Anyone" access + the long random URL is the only protection — treat the URL
like a password and never commit it.

## Security notes

- URLs, bin IDs and API keys are bearer credentials. They live in local
  storage on each device and are **not** included in exported `.json`
  backups. URL-only providers (npoint, Pantry, custom HTTP) are readable by
  anyone holding the URL — prefer Apps Script or JSONBin for real data.
- Sync failures never block trading, journaling, or exports — the app works
  fully offline and just retries on the next change/pull.
- Remote payloads are validated like imported backups before being applied;
  a corrupt remote copy cannot overwrite good local state.
- The service worker never caches sync traffic.
