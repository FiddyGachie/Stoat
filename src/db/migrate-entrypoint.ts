/**
 * Standalone migration runner — used by Render's preDeployCommand.
 * Compiled to dist/src/db/migrate-entrypoint.js and run as:
 *   node dist/src/db/migrate-entrypoint.js
 *
 * Reads DATABASE_URL from the environment (set by Render via the Blueprint's
 * fromDatabase binding). Falls back to embedded PGlite only in test/dev.
 */
import 'dotenv/config';
import { initDb } from './connection.js';
import { runMigrations } from './migrate.js';

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    // On Render this should never happen — DATABASE_URL is injected via Blueprint.
    console.error(
      '[Migrate] DATABASE_URL is not set. ' +
        'Ensure the stoat-db fromDatabase binding is configured in render.yaml.'
    );
    process.exit(1);
  }

  console.log('[Migrate] Connecting to database...');
  initDb({ databaseUrl: dbUrl });

  const applied = await runMigrations();
  if (applied.length === 0) {
    console.log('[Migrate] All migrations already applied — nothing to do.');
  } else {
    console.log(`[Migrate] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

main().catch((err: unknown) => {
  console.error('[Migrate] Fatal migration error:', err);
  process.exit(1);
});
