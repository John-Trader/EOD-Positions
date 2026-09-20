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
// The app GETs this URL to pull its backup JSON and POSTs to it to push.
// The payload is stored as a plain file in YOUR Google Drive — nothing is
// sent anywhere else. The URL is the only credential: treat it like a
// password (anyone holding it can read/overwrite the stored backup).

const FILE_NAME = 'positioncalc-sync.json';

function doGet() {
  const file = getFile();
  const body = file ? file.getBlob().getDataAsString() : '{}';
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = (e && e.postData && e.postData.contents) || '{}';
  const file = getFile();
  if (file) file.setContent(body);
  else DriveApp.createFile(FILE_NAME, body, MimeType.PLAIN_TEXT);
  return ContentService.createTextOutput('{"ok":true}')
    .setMimeType(ContentService.MimeType.JSON);
}

function getFile() {
  const it = DriveApp.getFilesByName(FILE_NAME);
  return it.hasNext() ? it.next() : null;
}
