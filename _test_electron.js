// Tests for electron/main.js state-file resolution (schema-v1): pre-window
// discovery of primary vs fallback, malformed-file protection, atomic writes,
// the psc-state-v1 envelope shape, and the preload's minimal IPC surface.
const fs = require('fs');
const path = require('path');
const os = require('os');

const mainSrc = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
const start = mainSrc.indexOf('// ---------- settings file ----------');
const end = mainSrc.indexOf('// ---------- bridge log tee ----------');
const ipcStart = mainSrc.indexOf('// ---------- state IPC ----------');
const ipcEnd = mainSrc.indexOf('// ---------- window ----------');
if (start < 0 || end < 0 || ipcStart < 0 || ipcEnd < 0) { console.error('settings/IPC blocks not found'); process.exit(1); }
const block = mainSrc.slice(start, end) + mainSrc.slice(ipcStart, ipcEnd) + `
return {
  initializeSettingsFile, writeSettingsFile, inspectSettingsFile, settingsLocation,
  bootPayload, validStatePayload,
  get settingsPath() { return settingsPath; },
  get settingsSnapshot() { return settingsSnapshot; },
  get settingsWritable() { return settingsWritable; },
  get settingsLoadError() { return settingsLoadError; },
  get installId() { return installId; }
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
const PRIMARY = 'C:\\portable\\psc-state-v1.json';
const FALLBACK = 'C:\\userData\\psc-state-v1.json';

// A minimal valid state-file wrapper: { installId, state:{envelope} }.
const Schema = require('./state-schema.js');
function stateFile(installId, dataMut) {
  const env = Schema.createEmpty({ datasetId: 'ds_test', appVersion: '4.1.0' });
  if (dataMut) dataMut(env);
  return { installId: installId || 'in_test', state: env };
}
const validJson = (o) => JSON.stringify(o);

function loadBlock({ files = {}, dialogAnswers = [] } = {}) {
  const calls = { quit: 0, dialogs: [], errorBoxes: [] };
  const fsx = makeFs(files);
  const dialog = {
    showMessageBox: async (opts) => { calls.dialogs.push(opts); return { response: dialogAnswers.length ? dialogAnswers.shift() : (opts.defaultId ?? 0) }; },
    showErrorBox: (t, d) => { calls.errorBoxes.push([t, d]); }
  };
  const app = { quit: () => { calls.quit++; } };
  const ipcHandlers = {};
  const ipcMain = {
    on: (ch, fn) => { ipcHandlers[ch] = fn; },
    handle: (ch, fn) => { ipcHandlers[ch] = fn; }
  };
  const fn = new Function('fs', 'path', 'dialog', 'app', 'ipcMain', 'USER_DATA', 'SETTINGS_FILE_PRIMARY', 'SETTINGS_FILE_FALLBACK', 'console', block);
  const api = fn(fsx, path, dialog, app, ipcMain, 'C:\\userData', PRIMARY, FALLBACK, console);
  return { api, calls, files, ipcHandlers };
}

const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

(async () => {
  try {
    // ---------- inspectSettingsFile ----------
    {
      const { api } = loadBlock({ files: {} });
      assert(api.inspectSettingsFile('C:\\nope').status === 'missing', 'missing file');
      const files = { 'C:\\bad': '{oops' };
      const { api: a2 } = loadBlock({ files });
      assert(a2.inspectSettingsFile('C:\\bad').status === 'malformed', 'malformed json');
      // A valid JSON file that is NOT a psc-state envelope is malformed, not read.
      const filesOld = { 'C:\\old': validJson({ version: '4.0.0', riskValue: '100' }) };
      const { api: a3 } = loadBlock({ files: filesOld });
      assert(a3.inspectSettingsFile('C:\\old').status === 'malformed', 'legacy flat settings rejected');
      const files2 = { 'C:\\ok': validJson(stateFile('in_abc')) };
      const { api: a4 } = loadBlock({ files: files2 });
      const r = a4.inspectSettingsFile('C:\\ok');
      assert(r.status === 'valid' && r.data.installId === 'in_abc', 'envelope file parsed');
    }

    // ---------- fresh install → primary ----------
    {
      const { api } = loadBlock({ files: {} });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && api.settingsWritable, 'fresh install targets primary');
    }

    // ---------- fallback-only file is rediscovered ----------
    {
      const files = { [FALLBACK]: validJson(stateFile('in_fb', e => { e.data.settings.accountValue = '50000'; })) };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      assert(api.settingsPath === FALLBACK, 'fallback file rediscovered');
      assert(api.settingsSnapshot.state.data.settings.accountValue === '50000', 'snapshot loaded from fallback');
      assert(api.settingsSnapshot.installId === 'in_fb', 'installId travels with the file');
    }

    // ---------- both valid + identical → primary, no prompt ----------
    {
      const files = { [PRIMARY]: validJson(stateFile('in_a')), [FALLBACK]: validJson(stateFile('in_a')) };
      const { api, calls } = loadBlock({ files });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && calls.dialogs.length === 0, 'identical files: primary, no prompt');
    }

    // ---------- both valid, fallback newer → prompt; answers honored ----------
    {
      const files = { [PRIMARY]: validJson(stateFile('in_p')), [FALLBACK]: validJson(stateFile('in_r', e => { e.revision = 9; })), ['__mtime__' + FALLBACK]: 2000 };
      const { api, calls } = loadBlock({ files, dialogAnswers: [0] });
      await api.initializeSettingsFile();
      assert(calls.dialogs.length === 1, 'conflict prompts once');
      assert(api.settingsPath === FALLBACK && api.settingsSnapshot.state.revision === 9, 'recovered copy chosen');
    }
    {
      const files = { [PRIMARY]: validJson(stateFile('in_p')), [FALLBACK]: validJson(stateFile('in_r', e => { e.revision = 9; })), ['__mtime__' + FALLBACK]: 2000 };
      const { api } = loadBlock({ files, dialogAnswers: [1] });
      await api.initializeSettingsFile();
      assert(api.settingsPath === PRIMARY && api.settingsSnapshot.installId === 'in_p', 'portable copy chosen');
    }
    {
      const files = { [PRIMARY]: validJson(stateFile('in_p')), [FALLBACK]: validJson(stateFile('in_r', e => { e.revision = 9; })), ['__mtime__' + FALLBACK]: 2000 };
      const { api } = loadBlock({ files, dialogAnswers: [2] });
      await api.initializeSettingsFile();
      assert(api.settingsWritable === false, 'cancel disables writes');
      const w = api.writeSettingsFile({ installId: 'in_x', state: Schema.createEmpty({}) });
      assert(w.ok === false, 'writes disabled session refuses to write');
    }
    // fallback older → primary silently
    {
      const files = { [PRIMARY]: validJson(stateFile('in_p')), [FALLBACK]: validJson(stateFile('in_r')), ['__mtime__' + FALLBACK]: 500, ['__mtime__' + PRIMARY]: 9000 };
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
      assert(api.writeSettingsFile({ installId: 'in_x', state: Schema.createEmpty({}) }).ok === false, 'no overwrite of damaged file');
    }
    {
      const files = { [PRIMARY]: '{broken' };
      const { api, calls } = loadBlock({ files, dialogAnswers: [2] });            // quit
      const r = await api.initializeSettingsFile();
      assert(r === false && calls.quit === 1, 'quit honored');
    }

    // ---------- writeSettingsFile: envelope wrap, atomic, redirect on EACCES ----------
    {
      const files = {};
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const st = Schema.createEmpty({ datasetId: 'ds_x' });
      const r = api.writeSettingsFile({ installId: 'in_zz', state: st });
      assert(r.ok && r.location === 'portable', 'primary write ok');
      const written = JSON.parse(files[PRIMARY]);
      assert(written.fileVersion === 1 && written.installId === 'in_zz' && written.state.format === 'positioncalc-state', 'file wrapper shape');
      assert(api.installId === 'in_zz', 'installId latched from first save');
      assert(!Object.keys(files).some(k => k.endsWith('.tmp')), 'no temp file left behind');
    }
    {
      const eacces = new Error('EACCES'); eacces.code = 'EACCES';
      const files = { ['__fail__' + PRIMARY]: eacces, ['__fail__' + PRIMARY + '.tmp']: eacces };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const r = api.writeSettingsFile({ installId: 'in_a', state: Schema.createEmpty({}) });
      assert(r.ok && r.location === 'userData', 'write redirected to fallback');
      assert(JSON.parse(files[FALLBACK]).installId === 'in_a', 'fallback file written');
      assert(api.settingsPath === FALLBACK, 'subsequent writes stick to fallback');
    }
    {
      const eperm = new Error('EPERM'); eperm.code = 'EPERM';
      const files = { ['__fail__' + PRIMARY + '.tmp']: eperm, ['__fail__' + FALLBACK + '.tmp']: eperm };
      const { api } = loadBlock({ files });
      await api.initializeSettingsFile();
      const r = api.writeSettingsFile({ installId: 'in_a', state: Schema.createEmpty({}) });
      assert(r.ok === false && /EPERM/.test(r.error), 'real write failure propagates');
    }

    // ---------- IPC payload validation ----------
    {
      const { api } = loadBlock({ files: {} });
      await api.initializeSettingsFile();
      assert(api.validStatePayload({ installId: 'in_1', state: Schema.createEmpty({}) }) === null, 'valid payload accepted');
      assert(api.validStatePayload({ state: { format: 'other' } }) !== null, 'wrong format rejected');
      assert(api.validStatePayload(null) !== null && api.validStatePayload([1]) !== null, 'non-object rejected');
      assert(api.bootPayload().installId === '' && api.bootPayload().state === null, 'fresh boot payload empty');
      api.writeSettingsFile({ installId: 'in_boot', state: Schema.createEmpty({}) });
      const bp = api.bootPayload();
      assert(bp.installId === 'in_boot' && bp.state && bp.state.format === 'positioncalc-state', 'boot payload serves saved snapshot');
    }

    // ---------- preload exposes only the four state IPC calls ----------
    {
      const plSrc = fs.readFileSync(path.join(__dirname, 'electron', 'preload.js'), 'utf8');
      assert(!/SEED_KEYS/.test(plSrc), 'preload no longer seeds localStorage');
      assert(/bootState.*psc:boot-state/.test(plSrc), 'bootState wired');
      assert(/saveStateSync.*psc:state-save-sync/.test(plSrc), 'saveStateSync wired');
      assert(/saveState.*psc:state-save/.test(plSrc), 'saveState wired');
      assert(/stateStatus.*psc:state-status/.test(plSrc), 'stateStatus wired');
      assert(!/psc:settings-load|psc:settings-save|psc:load-settings-async/.test(plSrc), 'legacy IPC surface gone');
    }

    console.log('All electron settings tests passed');
  } catch (e) {
    console.error(e.stack || e);
    process.exit(1);
  }
})();
