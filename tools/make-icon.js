// Rasterizes icon.svg -> build/icon.png (512x512) for electron-builder + window icon.
'use strict';
const path = require('path');
const fs = require('fs');

(async () => {
    const sharp = require('sharp');
    const src = path.join(__dirname, '..', 'icon.svg');
    const out = path.join(__dirname, '..', 'build', 'icon.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(src, { density: 300 }).resize(512, 512).png().toFile(out);
    console.log('icon ->', out);
})().catch((e) => { console.error('icon build failed:', e.message); process.exit(1); });
