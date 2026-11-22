// Generates the three iCUE widget folders in widgets/ from the shared files in src/.
// Run:  node build.js     then package each folder with the Corsair CLI (icuewidget package widgets/<Name>).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WIDGETS = [
  // logo: the service's own mark in src/logos; inset: its margin inside the 64px package icon.
  { dir: 'ClaudeUsage', provider: 'claude', brand: 'Claude', logo: 'claude.png', inset: 7 },
  { dir: 'ChatGPTUsage', provider: 'chatgpt', brand: 'ChatGPT', logo: 'chatgpt.png', inset: 13 },
  { dir: 'AntigravityUsage', provider: 'antigravity', brand: 'Antigravity', logo: 'antigravity.svg', inset: 11 },
];
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'widgets');
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

fs.rmSync(OUT, { recursive: true, force: true });
for (const w of WIDGETS) {
  const out = path.join(OUT, w.dir);
  const ext = path.extname(w.logo);
  const logo = fs.readFileSync(path.join(SRC, 'logos', w.logo));
  const vars = {
    PROVIDER: w.provider, BRAND: w.brand, TITLE: `${w.brand} Usage`,
    LOGO: `resources/logo${ext}`,
    // The package icon is a single file, so the logo is embedded in it.
    LOGO_DATA: `data:${MIME[ext]};base64,${logo.toString('base64')}`, LOGO_INSET: w.inset, LOGO_SIZE: 64 - 2 * w.inset,
  };
  write(path.join(out, vars.LOGO), logo);
  write(path.join(out, 'index.html'), fill(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'), vars));
  write(path.join(out, 'resources', 'icon.svg'), fill(fs.readFileSync(path.join(SRC, 'icon.svg'), 'utf8'), vars));
  for (const f of ['styles/widget.css', 'scripts/widget.js']) write(path.join(out, f), fs.readFileSync(path.join(SRC, f), 'utf8'));
  write(path.join(out, 'resources', 'fonts', 'NotoSansThai.ttf'), fs.readFileSync(path.join(SRC, 'fonts', 'NotoSansThai.ttf')));
  write(path.join(out, 'manifest.json'), JSON.stringify({
    author: 'Riko',
    id: `com.riko.${w.provider}-usage`,
    name: `${w.brand} Usage`,
    description: `Remaining ${w.brand} usage quota, read from the local usage server (localhost:8787).`,
    version: '1.2.0',
    preview_icon: 'resources/icon.svg',
    min_app_version: '5.52',
    min_framework_version: '1.9.0',
    os: [{ platform: 'windows' }],
    supported_devices: [{ type: 'dashboard_lcd' }],
    permissions: [{ type: 'url', domain: 'localhost', port: 8787 }],
  }, null, 2) + '\n');
  console.log('built', path.relative(__dirname, out));
}
