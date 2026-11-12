/**
 * Copies non-TS assets (SQL migrations, fixtures) into dist/ after tsc build.
 * tsc only compiles .ts files — .sql, .json, .html etc. need manual copying.
 *
 * This runs as part of `npm run build` via: tsc && node scripts/copy-assets.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`[copy-assets] Source not found: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      console.log(`[copy-assets] ${path.relative(ROOT, s)} -> ${path.relative(ROOT, d)}`);
    }
  }
}

// 1. SQL migrations
copyDir(
  path.join(ROOT, 'src/db/migrations'),
  path.join(ROOT, 'dist/src/db/migrations'),
);

// 2. Fixture files (needed by the grounded verifier at runtime)
copyDir(
  path.join(ROOT, 'fixtures'),
  path.join(ROOT, 'dist/fixtures'),
);

console.log('[copy-assets] Done.');
