#!/usr/bin/env node
/**
 * build.js
 * Reads config.json and injects values into manifest.json,
 * then zips the extension into dist/gcal-clickup-importer-vX_X_X.zip
 *
 * Usage:
 *   node build.js
 *
 * Requirements:
 *   npm install archiver   (only needed for zip output)
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const MANIFEST = path.join(ROOT, 'manifest.json');
const CONFIG   = path.join(ROOT, 'config.json');
const DIST     = path.join(ROOT, 'dist');
const OUT_MANIFEST = path.join(DIST, 'manifest.json');

// ── 1. Load config ────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG)) {
  console.error('ERROR: config.json not found. Copy config.json.example to config.json and fill in your values.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (!config.google_client_id || config.google_client_id.includes('YOUR_CLIENT_ID')) {
  console.error('ERROR: config.json still has a placeholder. Set google_client_id to your real OAuth client ID.');
  process.exit(1);
}

// ── 2. Inject into manifest ───────────────────────────────────────────────────
let manifest = fs.readFileSync(MANIFEST, 'utf8');
manifest = manifest.replace('{{GOOGLE_CLIENT_ID}}', config.google_client_id);

const parsed = JSON.parse(manifest); // validate JSON
if (parsed.oauth2.client_id.includes('{{')) {
  console.error('ERROR: Placeholder not replaced. Check config.json.');
  process.exit(1);
}

// ── 3. Write to dist/ ─────────────────────────────────────────────────────────
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

// Copy all extension files to dist/
const FILES = [
  'background.js',
  'content.js',
  'gcal-content.js',
  'gcal-content.css',
  'options.html',
  'options.js',
  'options.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'README.md'
];

// Copy icons folder
const ICONS_SRC = path.join(ROOT, 'icons');
const ICONS_DST = path.join(DIST, 'icons');
if (fs.existsSync(ICONS_SRC)) {
  if (!fs.existsSync(ICONS_DST)) fs.mkdirSync(ICONS_DST);
  fs.readdirSync(ICONS_SRC).forEach(f => {
    fs.copyFileSync(path.join(ICONS_SRC, f), path.join(ICONS_DST, f));
  });
}

FILES.forEach(f => {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, f));
  }
});

// Write the injected manifest into dist/
fs.writeFileSync(OUT_MANIFEST, JSON.stringify(parsed, null, 2));

console.log('✓ Built to dist/');
console.log('  client_id:', config.google_client_id);

// ── 4. Optionally zip dist/ ───────────────────────────────────────────────────
try {
  const archiver = require('archiver');
  // Name the zip from the (injected) manifest version: gcal-clickup-importer-vX_X_X.zip
  const zipName  = 'gcal-clickup-importer-v' + parsed.version.replace(/\./g, '_') + '.zip';
  const zipPath  = path.join(DIST, zipName);
  const output   = fs.createWriteStream(zipPath);
  const archive  = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    console.log('✓ Zipped:', archive.pointer(), 'bytes →', 'dist/' + zipName);
  });

  archive.pipe(output);
  FILES.forEach(f => {
    const p = path.join(DIST, f);
    if (fs.existsSync(p)) archive.file(p, { name: f });
  });
  archive.file(OUT_MANIFEST, { name: 'manifest.json' });
  // Include icons
  if (fs.existsSync(ICONS_DST)) {
    archive.directory(ICONS_DST, 'icons');
  }
  archive.finalize();
} catch (e) {
  if (e && e.code === 'MODULE_NOT_FOUND') {
    console.log('  (Skipping zip — run "npm install archiver" to enable auto-zip)');
  } else {
    console.log('  (Zip step failed:', e && e.message, '— dist/ is still valid for "Load unpacked")');
  }
}
