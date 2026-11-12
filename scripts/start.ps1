# Stoat local startup script (PowerShell)
# Usage:  pwsh scripts/start.ps1  (or just:  .\scripts\start.ps1)
# Installs deps, builds, migrates, seeds, and starts the API server.

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot/.."

Write-Host "Stoat v2.0 - Local Startup" -ForegroundColor Cyan
Write-Host "---------------------------" -ForegroundColor Cyan

# ── 1. Install deps ─────────────────────────────────────────────────────────
if (-not (Test-Path node_modules)) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# ── 2. Build ────────────────────────────────────────────────────────────────
Write-Host "Building TypeScript..." -ForegroundColor Yellow
npm run build

# ── 3. Migrate ───────────────────────────────────────────────────────────────
Write-Host "Running migrations..." -ForegroundColor Yellow
node dist/src/db/migrate-entrypoint.js

# ── 4. Seed (only if no tenants exist) ───────────────────────────────────────
Write-Host "Seeding demo data..." -ForegroundColor Yellow
node --input-type=module -e "
import { initDb, getDb, closeDb } from './dist/src/db/connection.js';
import 'dotenv/config';
initDb();
const db = getDb();
const t = await db.query('SELECT id FROM tenants LIMIT 1');
if (t.rows.length === 0) {
  const { seedDatabase } = await import('./dist/src/db/seed.js');
  await seedDatabase(db);
  console.log('[Seed] Done.');
} else {
  console.log('[Seed] Skipped - tenant already exists.');
}
await closeDb();
" 2>$null

# ── 5. Start ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Starting API server..." -ForegroundColor Green
Write-Host "  Health:  http://localhost:3000/v1/health" -ForegroundColor DarkGray
Write-Host "  Ready:   http://localhost:3000/v1/ready" -ForegroundColor DarkGray
Write-Host "  Console: run 'npm run console' in another terminal" -ForegroundColor DarkGray
Write-Host ""
npm start
