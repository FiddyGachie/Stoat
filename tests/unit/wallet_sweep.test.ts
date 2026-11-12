// Task 8.6: wallet sweep (R3.3, 3.6, 3.10, 3.17, 9.15).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { getOrCreateWallet } from "../../src/modules/wallet/wallet.service.js";
import { runWalletSweep } from "../../src/modules/wallet/wallet.sweep.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();

describe("runWalletSweep", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
  });
  afterAll(async () => {
    await closeDb();
  });

  it("blocks a drifted wallet, and fails stale reconciliation runs only", async () => {
    const w = await getOrCreateWallet(db(), {
      tenantId: T,
      ownerUserId: SEED_IDS.userId,
      currency: "USD",
      environment: "sandbox",
    });
    await db().query(`UPDATE wallets SET balance_cache = 7 WHERE id = $1`, [w.id]);
    await db().query(
      `INSERT INTO reconciliation_runs (tenant_id, trigger, status, paypal_environment, started_at)
       VALUES ($1, 'schedule', 'running', 'sandbox', now() - interval '2 hours')`,
      [T],
    );

    const r = await runWalletSweep(db());
    expect(r.balanceChecks.blocked).toBeGreaterThanOrEqual(1);
    expect(r.staleReconciliations).toBe(1);
    const status = (await db().query<{ status: string }>(`SELECT status FROM wallets WHERE id = $1`, [w.id])).rows[0].status;
    expect(status).toBe("blocked");

    const again = await runWalletSweep(db());
    expect(again.staleReconciliations).toBe(0);
  });
});
