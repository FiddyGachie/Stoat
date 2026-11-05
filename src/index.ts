/**
 * Server entry point — works locally (tsx) and on Render (node dist/src/index.js).
 *
 * On Render:
 *  - DATABASE_URL is injected via Blueprint fromDatabase binding
 *  - PORT is set to 10000 by the Blueprint
 *  - Migrations are run in preDeployCommand (not here)
 *
 * Locally:
 *  - DATABASE_URL from .env; if absent, falls back to embedded PGlite
 *  - Migrations run on every startup for convenience
 */
import "dotenv/config";
import { createApp } from "./api/app.js";
import { initDb, getDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";

// Render injects PORT=10000 via Blueprint; local default is 3000
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_RENDER = process.env.RENDER === "true";

async function main() {
  // Initialise DB connection
  initDb();
  const db = getDb();

  if (!IS_RENDER) {
    // On Render, preDeployCommand handles migrations before the first process starts.
    // Run migrations inline only in local dev so it stays convenient.
    await runMigrations(db);
    console.log("[Startup] Migrations complete.");
  }

  const app = createApp();

  // Render requires binding to 0.0.0.0 (not 127.0.0.1)
  app.listen(PORT, "0.0.0.0", () => {
    const env = process.env.NODE_ENV ?? "development";
    console.log(`[Startup] Stoat API v2.0.0 — ${env}`);
    console.log(`[Startup] Listening on 0.0.0.0:${PORT}`);
    console.log(`[Startup] Health:   /v1/health`);
    console.log(`[Startup] Ready:    /v1/ready`);
    console.log(`[Startup] LLM_MODE: ${process.env.LLM_MODE ?? "replay"}`);
    console.log(
      `[Startup] Provider: ${process.env.LLM_PROVIDER ?? "fireworks"}`,
    );
    if (IS_RENDER) console.log("[Startup] Running on Render");
  });
}

main().catch((err: unknown) => {
  console.error("[Startup] Fatal error:", err);
  process.exit(1);
});
