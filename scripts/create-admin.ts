/**
 * Create (or reset) an operator/supervisor account.
 *
 *   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='a-long-passphrase' npm run admin:create
 *
 * Optional environment variables:
 *   ADMIN_ROLE          operator (default) | supervisor
 *   ADMIN_TENANT_ID     attach to an existing organization (UUID) instead of creating one
 *   ADMIN_ORG           name for a newly created organization (default "Stoat Operations")
 *   DATABASE_URL        required: the persistent PostgreSQL database to write to
 *
 * The password is read from the environment, never from a command-line argument (so it does
 * not land in shell history or process listings) and is never printed. Re-running with the
 * same email resets that operator's password and role.
 */
import "dotenv/config";
import { initDb, getDb, closeDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { AuthService } from "../src/modules/auth/auth.service.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Refusing to create an admin in a throwaway in-memory database; " +
        "point DATABASE_URL at your persistent PostgreSQL instance.",
    );
  }
  initDb({ databaseUrl: process.env.DATABASE_URL });
  const db = getDb();
  await runMigrations(db); // no-op when already migrated; guarantees the schema exists

  const result = await new AuthService(db).createOperator({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    role: process.env.ADMIN_ROLE,
    tenantId: process.env.ADMIN_TENANT_ID,
    organizationName: process.env.ADMIN_ORG,
  });

  console.log(result.created ? "Created" : "Updated", `${result.role} account.`);
  console.log(`  organization (tenant) id: ${result.tenant_id}`);
  console.log(`  user id:                  ${result.user_id}`);
  console.log("Sign in at the console with that email and password.");
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error("admin:create failed:", error instanceof Error ? error.message : error);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
