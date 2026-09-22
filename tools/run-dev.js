// Dev launcher — spawns the real Electron binary with a clean env.
// ELECTRON_RUN_AS_NODE can leak in from IDE/agent terminals and would make
// Electron run main.js as plain Node; strip it unconditionally.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // resolves to the binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const p = spawn(electron, ['.'], {
    stdio: 'inherit',
    env,
    cwd: path.join(__dirname, '..')   // '.' must resolve package.json regardless of caller cwd
});
p.on('error', (err) => {
    console.error('[run-dev] failed to spawn Electron:', err && err.message ? err.message : err);
    process.exit(1);
});
// Truthful exit: propagate the child's exit code; on signal exit, re-raise so
// the caller sees the same termination rather than a clean 0.
p.on('close', (code, signal) => {
    if (signal) { try { process.kill(process.pid, signal); } catch (e) { process.exit(1); } return; }
    process.exit(code || 0);
});
