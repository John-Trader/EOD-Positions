// Tests for electron/main.js settings-file resolution (B03): pre-window
// discovery of primary vs fallback, malformed-file protection, atomic writes,
// and the preload's whitelisted seeding (no arbitrary file keys in storage).
const fs = require('fs');
const path = require('path');
const os = require('os');

const mainSrc = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
const start = mainSrc.indexOf('// ---------- settings file ----------');
const end = mainSrc.indexOf('// ---------- bridge log tee ----------');
if (start < 0 || end < 0) { console.error('settings block not found'); process.exit(1); }
const block = mainSrc.slice(start, end) + `
return {
  initializeSettingsFile, writeSettingsFile, inspectSettingsFile, settingsLocation,
  get settingsPath() { return settingsPath; },
  get settingsSnapshot() { return settingsSnapshot; },
  get settingsWritable() { return settingsWritable; },
  get settingsLoadError() { return settingsLoadError; }
};`;

// In-memory FS shim over a real temp dir would need real files — use a fake fs.
function makeFs(files) {
  return {
    readFileSync(f) {
      if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      if (files[f] instanceof Error) { throw files[f]; }
      return files[f];
    },
    writeFileSync(f, data) {
      if (files['__fail__' + f]) { const e = files['__fail__' + f]; throw e; }
      files[f] = String(data);
    },
    renameSync(a, b) {
      if (files['__failrename__' + b]) { const e = files['__failrename__' + b]; throw e; }
      files[b] = files[a]; delete files[a];
    },
    rmSync(f) { delete files[f]; },
    statSync(f) { return { mtimeMs: (files['__mtime__' + f]) || 1000 }; },
    mkdirSync() {},
    existsSync(f) { return f in files; }
  };
}
const PRIMARY = 'C:\\portable\\psc-settings.json';
const FALLBACK = 'C:\\userData\\psc-settings.json';

function loadBlock({ files = {}, dialogAnswers = [] } = {}) {
  const calls = { quit: 0, dialogs: [], errorBoxes: [] };
  const fsx = makeFs(files);
  const dialog = {
    showMessageBox: async (opts) => { calls.dialogs.push(opts); return { response: dialogAnswers.length ? dialogAnswers.shift() : (opts.defaultId ?? 0) }; },
    showErrorBox: (t, d) => { calls.errorBoxes.push([t, d]); }
  };
  const app = { quit: () => { calls.quit++; } };
  const fn = new Function('fs', 'path', 'dialog', 'app', 'USER_DATA', 'SETTINGS_FILE_PRIMARY', 'SETTINGS_FILE_FALLBACK', 'console', block);
  const api = fn(fsx, path, dialog, app, 'C:\\userData', PRIMARY, FALLBACK, console);
  return { api, calls, files };
}

const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const validJson = (o) => JSON.stringify(o);

(async () => {
  try {
    // ---------- inspectSettingsFile ----------
    {
      const { api } = loadBlock({ files: {} });
      assert(api.inspectSettingsFile('C:\\nope').status === 'missing', 'missing file');
      const files = { 'C:\\bad': '{oops' };
      const { api: a2 } = loadBlock({ files });
      assert(a2.inspectSettingsFile('C:\\bad').status === 'malformed', 'malformed json');
      const files2 = { 'C:\\ok': validJson({ riskValue: '100' }) };
      const { api: a3 } = loadBlock({ files: files2 });
      const r = a3.inspectSettingsFile('C:\\ok');
      assert(r.status === 'valid' && r.data.riskValue === '100', 'valid file parsed');
    }

    // ---------- fresh install → primary ----------
    {
      const { api } = loadBlock({ files: {} });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && api.settingsWritable, 'fresh install targets primary');
    }

    // ---------- fallback-only file is rediscovered (the B03 regression) ----------
    {
      const files = { [FALLBACK]: validJson({ accountValue: '50000' }) };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      assert(api.settingsPath === FALLBACK, 'fallback file rediscovered');
      assert(api.settingsSnapshot.accountValue === '50000', 'snapshot loaded from fallback');
    }

    // ---------- both valid + identical → primary, no prompt ----------
    {
      const files = { [PRIMARY]: validJson({ a: '1' }), [FALLBACK]: validJson({ a: '1' }) };
      const { api, calls } = loadBlock({ files });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && calls.dialogs.length === 0, 'identical files: primary, no prompt');
    }

    // ---------- both valid, fallback newer → prompt; answers honored ----------
    {
      const files = { [PRIMARY]: validJson({ a: '1' }), [FALLBACK]: validJson({ a: '2' }), ['__mtime__' + FALLBACK]: 2000 };
      const { api, calls } = loadBlock({ files, dialogAnswers: [0] });
      await api.initializeSettingsFile();
      assert(calls.dialogs.length === 1, 'conflict prompts once');
      assert(api.settingsPath === FALLBACK && api.settingsSnapshot.a === '2', 'recovered copy chosen');
    }
    {
      const files = { [PRIMARY]: validJson({ a: '1' }), [FALLBACK]: validJson({ a: '2' }), ['__mtime__' + FALLBACK]: 2000 };
      const { api } = loadBlock({ files, dialogAnswers: [1] });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && api.settingsSnapshot.a === '1', 'portable copy chosen');
    }
    {
      const files = { [PRIMARY]: validJson({ a: '1' }), [FALLBACK]: validJson({ a: '2' }), ['__mtime__' + FALLBACK]: 2000 };
      const { api } = loadBlock({ files, dialogAnswers: [2] });
      await api.initializeSettingsFile();
      assert(api.settingsWritable === false, 'cancel disables writes');
      const w = api.writeSettingsFile({ x: 1 });
      assert(w.ok === false, 'writes disabled session refuses to write');
    }
    // fallback older → primary silently
    {
      const files = { [PRIMARY]: validJson({ a: '1' }), [FALLBACK]: validJson({ a: '2' }), ['__mtime__' + FALLBACK]: 500, ['__mtime__' + PRIMARY]: 9000 };
      const { api, calls } = loadBlock({ files });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && calls.dialogs.length === 0, 'older fallback ignored');
    }

    // ---------- malformed primary: never overwritten ----------
    {
      const files = { [PRIMARY]: '{broken' };
      const { api, calls, files: f } = loadBlock({ files, dialogAnswers: [0] });   // move aside
      await api.initializeSettingsFile();
      assert(calls.dialogs[0].type === 'warning', 'malformed warns');
      assert(Object.keys(f).some(k => k.startsWith(PRIMARY + '.corrupt-')), 'corrupt file moved aside');
      assert(api.settingsWritable === true, 'fresh start still writable');
    }
    {
      const files = { [PRIMARY]: '{broken' };
      const { api } = loadBlock({ files, dialogAnswers: [1] });                   // continue no-save
      await api.initializeSettingsFile();
      assert(api.settingsWritable === false && api.settingsPath === PRIMARY, 'continue-without-saving keeps path, disables writes');
      assert(api.writeSettingsFile({ x: 1 }).ok === false, 'no overwrite of damaged file');
    }
    {
      const files = { [PRIMARY]: '{broken' };
      const { api, calls } = loadBlock({ files, dialogAnswers: [2] });            // quit
      const r = await api.initializeSettingsFile();
      assert(r === false && calls.quit === 1, 'quit honored');
    }

    // ---------- writeSettingsFile: atomic, redirects on EACCES, reports failure ----------
    {
      const files = {};
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const r = api.writeSettingsFile({ riskValue: '100' });
      assert(r.ok && r.location === 'portable', 'primary write ok');
      assert(JSON.parse(files[PRIMARY]).riskValue === '100', 'primary file written');
      assert(!Object.keys(files).some(k => k.endsWith('.tmp')), 'no temp file left behind');
    }
    {
      const eacces = new Error('EACCES'); eacces.code = 'EACCES';
      const files = { ['__fail__' + PRIMARY]: eacces, ['__fail__' + PRIMARY + '.tmp']: eacces };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const r = api.writeSettingsFile({ a: '1' });
      assert(r.ok && r.location === 'userData', 'write redirected to fallback');
      assert(JSON.parse(files[FALLBACK]).a === '1', 'fallback file written');
      assert(api.settingsPath === FALLBACK, 'subsequent writes stick to fallback');
      const r2 = api.writeSettingsFile({ b: '2' });
      assert(r2.ok && JSON.parse(files[FALLBACK]).b === '2', 'second write goes to fallback directly');
    }
    {
      const eperm = new Error('EPERM'); eperm.code = 'EPERM';
      const files = { ['__fail__' + PRIMARY + '.tmp']: eperm, ['__fail__' + FALLBACK + '.tmp']: eperm };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const r = api.writeSettingsFile({ a: '1' });
      assert(r.ok === false && /EPERM/.test(r.error), 'real write failure propagates');
    }

    // ---------- preload seed whitelist (B03) ----------
    {
      const plSrc = fs.readFileSync(path.join(__dirname, 'electron', 'preload.js'), 'utf8');
      const pStart = plSrc.indexOf('const SEED_KEYS');
      const pEnd = plSrc.indexOf('contextBridge.exposeInMainWorld');
      assert(pStart >= 0 && pEnd > pStart, 'preload seed block found');
      const ls = {};
      const fakeIpc = { sendSync: () => ({
        riskValue: '250', twsBridgeToken: 'LEAK', junkKey: 'x',
        nested: { bad: true },
        apiKeys: { finnhub_key: 'fk', evil_key: 'EK', tiingo_key: 'tk' }
      }) };
      new Function('ipcRenderer', 'localStorage', 'require', plSrc.slice(pStart, pEnd))
        (fakeIpc, { setItem: (k, v) => { ls[k] = v; }, removeItem: (k) => { delete ls[k]; } }, () => ({}));
      assert(ls.riskValue === '250', 'whitelisted key seeded');
      assert(!('twsBridgeToken' in ls), 'bridge token never seeded');
      assert(!('junkKey' in ls) && !('nested' in ls), 'arbitrary keys not seeded');
      assert(ls.finnhub_key === 'fk' && ls.tiingo_key === 'tk', 'known API slots seeded');
      assert(!('evil_key' in ls), 'unknown API slot not seeded');
    }

    console.log('All electron settings tests passed');
  } catch (e) {
    console.error(e.stack || e);
    process.exit(1);
  }
})();
