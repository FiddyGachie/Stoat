/**
 * Standalone migration runner — used by Render's preDeployCommand and locally.
 * Compiled to dist/src/db/migrate-entrypoint.js and run as:
 *   node dist/src/db/migrate-entrypoint.js
 *
 * - If DATABASE_URL is set and reachable, migrates against that Postgres.
 * - If DATABASE_URL is set but the connection fails, falls back to embedded PGlite
 *   (local dev convenience — on Render this should never happen).
 * - If DATABASE_URL is absent, uses embedded PGlite.
 */
import "dotenv/config";
import { initDb, getDb } from "./connection.js";
import { runMigrations } from "./migrate.js";

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    // Try the configured database first
    console.log("[Migrate] Connecting to database...");
    initDb({ databaseUrl: dbUrl });

    try {
      // Quick connectivity check
      const db = getDb();
      await db.query("SELECT 1");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      console.warn(`[Migrate] Could not connect to DATABASE_URL (${msg}).`);
      console.warn("[Migrate] Falling back to embedded PGlite for local dev.");

      // Reset and use PGlite
      const { resetDb } = await import("./connection.js");
      await resetDb();
      initDb({ forceEmbedded: true });
    }
  } else {
    console.log("[Migrate] No DATABASE_URL set — using embedded PGlite.");
    initDb({ forceEmbedded: true });
  }

  const applied = await runMigrations();
  if (applied.length === 0) {
    console.log("[Migrate] All migrations already applied — nothing to do.");
  } else {
    console.log(
      `[Migrate] Applied ${applied.length} migration(s): ${applied.join(", ")}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error("[Migrate] Fatal migration error:", err);
  process.exit(1);
});
