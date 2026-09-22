// Position Size Calculator — Google Apps Script sync endpoint.
//
// Setup (one time, ~5 minutes):
//   1. Go to https://script.google.com → New project → paste this whole file.
//   2. Deploy → New deployment → type "Web app".
//      - Execute as: Me
//      - Who has access: Anyone
//   3. Copy the web-app URL (.../macros/s/AKfy.../exec) into the app:
//      Settings → Cloud Sync → Provider "Google Apps Script" → Endpoint URL.
//
// The app GETs this URL to pull its state envelope and POSTs to push.
// The payload is stored as a plain file in YOUR Google Drive — nothing is
// sent anywhere else. The URL is the only credential: treat it like a
// password (anyone holding it can read/overwrite the stored state).
//
// Writes are compare-and-swap under a script lock: the client sends
// {cas, state} where cas is the savedAt stamp of the remote it merged
// against. A mismatched stamp → {ok:false, conflict:true} → the client
// re-pulls, merges, retries. Two devices can never silently overwrite
// each other. A bare envelope body (no wrapper) is also accepted for
// compatibility with a first push.

const FILE_NAME = 'positioncalc-sync.json';

function doGet() {
  const file = getFile();
  const body = file ? file.getBlob().getDataAsString() : '{}';
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) {
    return json({ ok: false, error: 'busy' });
  }
  try {
    const body = (e && e.postData && e.postData.contents) || '{}';
    const file = getFile();
    let msg;
    try { msg = JSON.parse(body); } catch (err) {
      return json({ ok: false, error: 'invalid JSON' });
    }
    if (msg && msg.state !== undefined) {
      // CAS write — reject when the stored envelope moved since the client's merge base.
      const cur = file ? safeParse(file.getBlob().getDataAsString()) : null;
      const curSaved = (cur && cur.savedAt) || 0;
      if (cur && curSaved !== (msg.cas || 0)) {
        return json({ ok: false, conflict: true, currentSavedAt: curSaved });
      }
      writeBody(file, JSON.stringify(msg.state));
      return json({ ok: true, savedAt: msg.state.savedAt });
    }
    // Unwrapped push (no CAS) — accepted; the client only sends this when it
    // has merged immediately beforehand.
    writeBody(file, body);
    return json({ ok: true });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function getFile() {
  const it = DriveApp.getFilesByName(FILE_NAME);
  return it.hasNext() ? it.next() : null;
}
function writeBody(file, body) {
  if (file) file.setContent(body);
  else DriveApp.createFile(FILE_NAME, body, MimeType.PLAIN_TEXT);
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
