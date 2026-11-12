/**
 * Drizzle Kit configuration.
 *
 * DATABASE_URL is read from .env (via dotenv) for both local development and
 * production (Supabase). The URL must be the Supabase "Transaction pooler"
 * connection string (port 6543) for pooled connections, or the direct
 * connection string (port 5432) for migrations/schema pushes.
 *
 * Usage:
 *   pnpm db:generate   — generate migration files from schema changes
 *   pnpm db:push       — push schema directly to DB (dev only, no migration files)
 *   pnpm db:migrate    — apply generated migrations to the DB
 *   pnpm db:studio     — open Drizzle Studio (local DB browser)
 */
import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load .env before reading DATABASE_URL so the config works for both
// `pnpm db:generate` (no running server) and the test runner.
config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Add it to your .env file.\n" +
      "For Supabase use the pooler connection string:\n" +
      "  DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres\n" +
      "For local Postgres: DATABASE_URL=postgresql://user:password@localhost:5432/dbname",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/drizzle",
  dbCredentials: { url },
  // Supabase uses the 'public' schema by default.
  schemaFilter: ["public"],
  // Verbose output so CI logs show exactly what changed.
  verbose: true,
  strict: true,
});
