// Dev launcher — spawns the real Electron binary with a clean env.
// ELECTRON_RUN_AS_NODE can leak in from IDE/agent terminals and would make
// Electron run main.js as plain Node; strip it unconditionally.
'use strict';
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const p = spawn(electron, ['.'], { stdio: 'inherit', env });
p.on('close', (code) => process.exit(code || 0));
