/**
 * Server entry point — works locally (tsx) and on Render (node dist/src/index.js).
 *
 * On Render:
 *  - DATABASE_URL is injected via Blueprint fromDatabase binding
 *  - PORT is set to 10000 by the Blueprint
 *  - Migrations are run in preDeployCommand (not here)
 *
 * Locally:
 *  - If DATABASE_URL points to a reachable Postgres, uses it
 *  - If the connection fails (no local Postgres), falls back to embedded PGlite
 *  - Migrations AND seed run on every startup for convenience
 */
import "dotenv/config";
import { createApp } from "./api/app.js";
import { assertPayPalOnly } from "./modules/paypal/capabilities.js";
import { initDb, getDb, resetDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startPaymentSweeps } from "./modules/payments/sweep.js";
import { startJobRunner } from "./jobs/runner.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_RENDER = process.env.RENDER === "true";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  let usingPglite = false;

  if (dbUrl && !IS_RENDER) {
    console.log("[Startup] Connecting to database...");
    assertPayPalOnly();
initDb({ databaseUrl: dbUrl });
    try {
      const db = getDb();
      await db.query("SELECT 1");
      console.log("[Startup] Connected to PostgreSQL.");
    } catch (err: unknown) {
      console.warn(
        `[Startup] Could not reach DATABASE_URL (${(err as Error).message}).`,
      );
      console.warn("[Startup] Falling back to embedded PGlite for local dev.");
      await resetDb();
      initDb({ forceEmbedded: true });
      usingPglite = true;
    }
  } else if (IS_RENDER) {
    initDb();
  } else {
    console.log("[Startup] No DATABASE_URL — using embedded PGlite.");
    initDb({ forceEmbedded: true });
    usingPglite = true;
  }

  const db = getDb();

  if (!IS_RENDER) {
    // Run migrations inline for local dev convenience
    await runMigrations(db);
    console.log("[Startup] Migrations complete.");

    // Auto-seed demo data if using PGlite (fresh in-memory DB each restart)
    if (usingPglite) {
      try {
        const { seedDatabase } = await import("./db/seed.js");
        const tenants = await db.query("SELECT id FROM tenants LIMIT 1");
        if (tenants.rows.length === 0) {
          await seedDatabase(db);
          console.log("[Startup] Seed data inserted (local PGlite).");
        }
        // Public test logins for local testing (see TEST_ACCOUNTS.md). Never in production.
        const { seedDemoAccounts, demoAccountsEnabled } = await import("./db/demo-accounts.js");
        if (demoAccountsEnabled()) {
          await seedDemoAccounts(db);
          console.log("[Startup] Demo logins ready: buyer@demo.stoat.local / admin@demo.stoat.local (see TEST_ACCOUNTS.md).");
        }
      } catch (err: unknown) {
        console.warn(`[Startup] Could not seed: ${(err as Error).message}`);
      }
    }
  }

  const app = createApp();

  app.listen(PORT, "0.0.0.0", () => {
    startPaymentSweeps(getDb());
    if (process.env.RUN_JOBS_IN_API !== "false") startJobRunner(getDb(), { workerId: `api-${process.pid}` });
    const env = process.env.NODE_ENV ?? "development";
    console.log(`[Startup] Stoat API v2.1.0 — ${env}`);
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

import './modules/wallet/wallet.service.js'; // registers the wallet balance check hook
