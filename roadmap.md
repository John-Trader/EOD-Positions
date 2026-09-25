# Roadmap — Mobile remote access to the TWS bridge

Status: planned (not started). Decision record + implementation spec for using a
phone as a full remote/mirror of the PC app: paste and view signal cards, live
quotes, submit orders to TWS via the bridge, streamed confirmations back.

## Design decision

One app build, two entry points — no runtime mode switch. The existing
`twsReady()`/`bridgeHealth()` behavior already gives "use TWS when the bridge is
reachable, otherwise load the app normally" on any device.

- **Entry D — resilient (GitHub Pages):** phone opens
  `https://levifasten.github.io/End-of-day` (always loads). TWS features light
  up when the bridge is reachable; otherwise the full non-TWS app works
  (signal pasting, cards, sizing, CSV exports). Bridge URL + token pasted once
  in Settings → TWS Bridge.
- **Entry A — zero-config (bridge-served):** phone opens
  `https://<pc>.<tailnet>.ts.net`, served by the bridge itself → token
  auto-injected via the `psc-bridge` meta tag, same-origin (no CORS). Requires
  the bridge to be up to load anything — cannot substitute for D because the
  token-bearing page is deliberately `no-store` (SW won't cache it).

Both hit the same bridge API. `orderRef` dedupe already protects against
double-sends; auto-entry stays enabled on ONE device (the PC).

## Connectivity: Tailscale

- Install Tailscale on PC + phone (free tier; WireGuard-encrypted, works on
  cellular/off-LAN). Enable HTTPS certificates in the Tailscale admin console
  (requires MagicDNS).
- On PC: `tailscale serve --bg http://127.0.0.1:8787`
  → bridge reachable as `https://<pc>.<tailnet>.ts.net` with a real cert.
  TLS terminates at Tailscale and proxies to loopback — the bridge keeps its
  `127.0.0.1` bind (no LAN exposure, no firewall holes).

## Code changes (one small set enables both entry points)

1. `tws-bridge/server.js` — configurable public host:
   - New env/start opt `PSC_PUBLIC_HOST` (e.g. `pc.tailnet-name.ts.net`).
   - `requestHostOk()`: also accept `PSC_PUBLIC_HOST` (verify which `Host`
     header `tailscale serve` forwards — if it sends `localhost`, this is a
     no-op; cloudflared/ngrok can rewrite Host but Tailscale does not).
   - `isAllowedOrigin()`: accept `https://<PSC_PUBLIC_HOST>` — or the cleaner
     dynamic rule: allow an Origin whose host equals the request's Host host
     (same-origin requests from a page the bridge itself served are inherently
     safe). Keep the existing allowlist unchanged — the GitHub Pages origin is
     already present, so entry D needs no CORS change.
   - WS `/stream` upgrade gate: apply the same origin rule.
   - `listen()` stays `127.0.0.1` for standalone AND Electron — Tailscale
     proxies to loopback.
2. `index.html` — `isValidBridgeUrl()`:
   - Allow `https:` non-loopback hosts (tailnet name); keep rejecting
     userinfo/query/hash/path; keep `http:` restricted to loopback.
   - Required for BOTH entry points: the bridge-served write (~line 1120)
     stores `location.origin`, but boot re-validates the stored URL
     (~line 10107) and would discard a tailnet URL.
   - `wss://` derivation already handles `https` (`replace(/^http/, 'ws')`).
3. Tests:
   - `_test_portable.js`: update `isValidBridgeUrl` cases (accept https
     tailnet host; keep http LAN-IP rejection).
   - `_test_bridge.js` / `_test_security.js`: cover `PSC_PUBLIC_HOST` in
     `requestHostOk` + origin rules.
   - `node _run_tests.js` must stay green.
4. Docs: `tws-bridge/README.md` mobile-setup section; AGENTS.md rule updates.
   Keep versions in sync per release rules.

## Phone setup (after changes + Tailscale)

- **A:** open `https://<pc>.<tailnet>.ts.net` → app loads with token injected
  → "Add to Home screen" for the PWA.
- **D:** open `https://levifasten.github.io/End-of-day` → Settings → TWS
  Bridge → paste Bridge URL `https://<pc>.<tailnet>.ts.net` + the bridge
  token once (manual — see below).

### Bridge URL/token delivery on the phone — DECIDED: manual paste only

One-time manual setup on the phone — no Cloud Sync involvement:

1. The bridge token is printed at bridge start and stored in
   `tws-bridge/.bridge-token` (Electron: printed in the bridge log dock).
2. On the phone (Pages app): Settings → TWS Bridge → Bridge URL =
   `https://<pc>.<tailnet>.ts.net`, Bridge token = that token, TWS enabled.
3. Done — existing settings fields are reused as-is; the only app change is
   the relaxed `isValidBridgeUrl` so the https tailnet URL validates.

Why NOT sync `twsBridgeUrl`/`twsBridgeToken`: on the PC, `pscBridgeInfo`
overwrites them with the PC's own origin (`http://127.0.0.1:8787`) — via LWW
sync that loopback value would clobber the phone's tailnet URL. A separate
synced `remoteBridgeUrl`/`remoteBridgeToken` pair can be added later if
manual setup ever becomes annoying.

Entry points coexist with no toggle: A and D are the same build — the only
difference is which URL serves `index.html`. Bookmark D as the daily driver;
A works automatically whenever the tailnet URL is opened while the bridge is
up (token auto-injected via the meta tag). No in-app switching needed.

## Behavior matrix

| Bridge/TWS up | Entry A (tailnet)                | Entry D (Pages)                     |
|---------------|----------------------------------|-------------------------------------|
| yes           | full remote: cards, live ticks,  | same — after one-time URL+token     |
|               | orders, streamed confirms        |                                     |
| no            | loads nothing                    | full app minus TWS features         |

## Notes / risks

- Exe port fallback: the Electron bridge falls back to a random port if 8787
  is busy — `tailscale serve` targets a fixed port, so keep 8787 free or run
  the standalone bridge for the remote-serving role.
- Keep auto-entry/auto-send enabled on one device (PC) — the `autoEntryRun`
  latch is machine-local.
- Never expose the bridge via a public tunnel (ngrok/Cloudflare) without an
  auth layer in front; Tailscale keeps it private by default.
- Optional complement: enable Cloud Sync so pasted signals/journal merge
  between phone and PC (already built).
- Optional hardening (separate task): Task Scheduler auto-logon + auto-start
  TWS + standalone bridge so the stack comes up on boot without manual login.

## Phase 0 — Discord signal ingestion via MacroDroid (in progress)

Phone-side: Discord app notifications → **MacroDroid macro** (Notification
Received trigger, app = Discord + optional text filter) → HTTP POST of
`{notification}`/`{not_title}` to `http://<PC-LAN-IP>:8787/signals` with the
`X-Bridge-Token` header. (BuzzKill is NOT in the chain — verified: it has no
HTTP/webhook action and no other way to move notification content off-device;
its Trigger Tasker/MacroDroid actions would just add a hop.) Over Tailscale
the same POST targets `https://<pc>.<tailnet>.ts.net/signals` and works off
LAN. The receiver is the BRIDGE, not the app — a web page can't accept HTTP
and may not be open.

Bridge/app additions when built:
- New `POST /signals` endpoint (token-auth'd, `{text, source}`) — stores the
  latest raw signal text and broadcasts it over `/stream`.
- App parses via the existing `parseEodSignalText` → same card render +
  auto-entry path as pasted signals; dedupe by message hash/timestamp.

Known limitation: Android/Discord notifications truncate long messages. If
the provider's lists get cut, upgrade path = PC-side DOM scrape (Playwright
with a persistent logged-in Chrome profile) triggered by the BuzzKill ping —
notification is the trigger, the scrape gets full-fidelity text. Never a
self-bot: Discord's own ToS bans user-account automation regardless of the
channel owner's permission.

## Deferred option — cloud-hosted TWS (not recommended initially)

VPS running IB Gateway + IBC (auto-login/restart) + `tws-bridge` + Tailscale
gives 24/7 without the PC. Costs VPS ops, IBKR re-auth fragility (2FA /
maintenance resets), ~$10–20/mo. Revisit only if "PC must be on" proves
painful. The truly serverless IBKR path (hosted OAuth Web API) requires
developer onboarding and a bridge-layer rewrite — not worth it.
