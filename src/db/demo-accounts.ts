/**
 * Demo / test accounts so a tester can sign in right after `npm run dev`, without signing up.
 *
 * These credentials are PUBLIC (listed in TEST_ACCOUNTS.md) and exist only in the tester's own
 * local database. They are created:
 *   - automatically when the API runs on the embedded database (no DATABASE_URL), and
 *   - on demand with `npm run seed:demo` (e.g. against the docker-compose Postgres).
 * Never in production: NODE_ENV=production or DEMO_ACCOUNTS=false turns this off.
 *
 * Idempotent: running it again resets these demo passwords and agent secrets to the values below.
 */
import type { DbClient } from "./connection.js";
import { hashCredential } from "../common/auth-crypto.js";
import { SEED_IDS } from "./seed.js";

export const DEMO_ACCOUNTS = {
  password: "StoatDemo-2026!",
  buyer: { id: "00000000-0000-0000-0000-0000000000b1", email: "buyer@demo.stoat.local", role: "buyer" },
  admin: { id: "00000000-0000-0000-0000-0000000000a1", email: "admin@demo.stoat.local", role: "operator" },
  buyerAgent: { id: SEED_IDS.buyerAgentId, secret: "stoat-demo-buyer-agent-secret-2026" },
  providerAgent: { id: SEED_IDS.providerAgentId, secret: "stoat-demo-provider-agent-secret-2026" },
} as const;

export function demoAccountsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.DEMO_ACCOUNTS !== "false";
}

/** Create or reset the demo logins in the seeded demo organisation. Requires seedDatabase first. */
export async function seedDemoAccounts(db: DbClient): Promise<void> {
  if (!demoAccountsEnabled()) return;
  const t = await db.query(`SELECT id FROM tenants WHERE id = $1`, [SEED_IDS.tenantId]);
  if (!t.rows.length) throw new Error("Demo organisation not found; run the base seed first.");

  const pw = await hashCredential(DEMO_ACCOUNTS.password);
  for (const u of [DEMO_ACCOUNTS.buyer, DEMO_ACCOUNTS.admin]) {
    await db.query(
      `INSERT INTO users (id, tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
      [u.id, SEED_IDS.tenantId, u.email, u.role, pw],
    );
  }
  // The demo buyer owns the demo agents, so the buyer portal, wallet and missions resolve to them.
  for (const a of [DEMO_ACCOUNTS.buyerAgent, DEMO_ACCOUNTS.providerAgent]) {
    await db.query(
      `UPDATE agents SET credential_hash = $2, owner_user_id = $3, status = 'active' WHERE id = $1`,
      [a.id, await hashCredential(a.secret), DEMO_ACCOUNTS.buyer.id],
    );
  }
}
