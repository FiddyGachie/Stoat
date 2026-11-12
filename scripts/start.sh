#!/usr/bin/env bash
# Stoat local startup script — sets up DB, runs migrations, seeds, starts API.
# Usage:  bash scripts/start.sh
# Windows: bash scripts/start.sh   (Git Bash, WSL, or MSYS2)

set -euo pipefail

cd "$(dirname "$0")/.."
echo "🦦 Stoat v2.0 — Local Startup"
echo "──────────────────────────────"

# ── 1. Install deps ─────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

# ── 2. Build ────────────────────────────────────────────────────────────────
echo "🔨 Building TypeScript..."
npm run build

# ── 3. Migrate ───────────────────────────────────────────────────────────────
echo "🗄  Running migrations..."
node dist/src/db/migrate-entrypoint.js

# ── 4. Seed (only if no tenants exist) ───────────────────────────────────────
echo "🌱 Seeding demo data..."
node -e "
import('./dist/src/db/connection.js').then(async ({initDb,getDb,closeDb}) => {
  import('dotenv/config');
  initDb();
  const db = getDb();
  const t = await db.query('SELECT id FROM tenants LIMIT 1');
  if (t.rows.length === 0) {
    const { seedDatabase } = await import('./dist/src/db/seed.js');
    await seedDatabase(db);
    console.log('[Seed] Done.');
  } else {
    console.log('[Seed] Skipped — tenant already exists.');
  }
  await closeDb();
}).catch(e => { console.error(e.message); process.exit(1); });
"

# ── 5. Start ────────────────────────────────────────────────────────────────
echo ""
echo "🚀 Starting API server..."
echo "   Health: http://localhost:3000/v1/health"
echo "   Ready:  http://localhost:3000/v1/ready"
echo "   Console: run 'npm run console' in another terminal"
echo ""
npm start
