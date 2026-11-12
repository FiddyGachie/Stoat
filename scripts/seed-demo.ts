/**
 * Create the demo organisation and the public test logins in the database named by DATABASE_URL
 * (for example the docker-compose Postgres). Safe to run more than once. Refused in production.
 *
 *   npm run seed:demo
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { DEMO_ACCOUNTS, demoAccountsEnabled, seedDemoAccounts } from "../src/db/demo-accounts.js";

async function main() {
  if (!demoAccountsEnabled()) {
    console.error("Demo accounts are disabled (NODE_ENV=production or DEMO_ACCOUNTS=false). Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const db = getDb();
  await runMigrations(db);
  await seedDatabase(db);
  await seedDemoAccounts(db);
  console.log("Demo accounts are ready (see TEST_ACCOUNTS.md):");
  console.log(`  buyer  ${DEMO_ACCOUNTS.buyer.email}`);
  console.log(`  admin  ${DEMO_ACCOUNTS.admin.email}`);
  console.log(`  agents ${DEMO_ACCOUNTS.buyerAgent.id} (buyer), ${DEMO_ACCOUNTS.providerAgent.id} (provider)`);
}

main()
  .catch((err) => { console.error(`seed:demo failed: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(() => closeDb());
